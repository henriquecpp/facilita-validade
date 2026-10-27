import { readFileSync } from 'node:fs';
import { importPKCS8, SignJWT } from 'jose';
import type { PushMessage } from '../../domain/push.js';
import type { PushOutcome } from './web-push.js';

/**
 * Push no coletor pelo Firebase Cloud Messaging (API HTTP v1). O servidor se autentica com a
 * conta de serviço do projeto Firebase; o aplicativo recebe do servidor a configuração do
 * projeto (`client`) e registra o aparelho, então o mesmo APK serve a qualquer servidor.
 */
export interface FcmConfig {
  readonly projectId: string;
  readonly clientEmail: string;
  readonly privateKey: string;
  /** Configuração pública do app Android no projeto, entregue ao coletor. */
  readonly client: { readonly appId: string; readonly apiKey: string; readonly senderId: string };
}

/**
 * Lê a conta de serviço (FCM_SERVICE_ACCOUNT_FILE, um caminho, ou FCM_SERVICE_ACCOUNT_JSON, o
 * conteúdo) e os dados do app Android (FCM_APP_ID, FCM_API_KEY, FCM_SENDER_ID). Sem conta de
 * serviço, o push do coletor fica desligado.
 */
export function fcmFromEnv(env: NodeJS.ProcessEnv = process.env): FcmConfig | null {
  const file = env.FCM_SERVICE_ACCOUNT_FILE?.trim();
  const text = file ? readFileSync(file, 'utf8') : env.FCM_SERVICE_ACCOUNT_JSON?.trim();
  if (!text) return null;
  let account: { project_id?: unknown; client_email?: unknown; private_key?: unknown };
  try {
    account = JSON.parse(text) as typeof account;
  } catch {
    throw new Error('A conta de serviço do Firebase não é um JSON válido.');
  }
  const { project_id: projectId, client_email: clientEmail, private_key: privateKey } = account;
  if (
    typeof projectId !== 'string' ||
    typeof clientEmail !== 'string' ||
    typeof privateKey !== 'string'
  )
    throw new Error(
      'A conta de serviço do Firebase não tem project_id, client_email e private_key.',
    );
  const appId = env.FCM_APP_ID?.trim();
  const apiKey = env.FCM_API_KEY?.trim();
  const senderId = env.FCM_SENDER_ID?.trim();
  if (!appId || !apiKey || !senderId)
    throw new Error('Informe FCM_APP_ID, FCM_API_KEY e FCM_SENDER_ID do app Android no Firebase.');
  return { projectId, clientEmail, privateKey, client: { appId, apiKey, senderId } };
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export class FcmSender {
  private access?: { token: string; expiresAt: number };
  constructor(
    readonly config: FcmConfig,
    readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    readonly now: () => number = () => Date.now(),
  ) {}

  /** Token OAuth da conta de serviço, reaproveitado até um minuto antes de vencer. */
  private async accessToken(): Promise<string> {
    if (this.access && this.access.expiresAt - 60_000 > this.now()) return this.access.token;
    const issuedAt = Math.floor(this.now() / 1000);
    const assertion = await new SignJWT({ scope: SCOPE })
      .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
      .setIssuer(this.config.clientEmail)
      .setAudience(TOKEN_URL)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 3600)
      .sign(await importPKCS8(this.config.privateKey, 'RS256'));
    const response = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
    };
    if (!response.ok || !payload.access_token)
      throw new Error(`O Google recusou a conta de serviço do Firebase (HTTP ${response.status}).`);
    this.access = {
      token: payload.access_token,
      expiresAt: this.now() + (payload.expires_in ?? 3600) * 1000,
    };
    return this.access.token;
  }

  /** Envia ao aparelho; `GONE` quando o token não vale mais (app removido ou reinstalado). */
  async send(token: string, message: PushMessage): Promise<PushOutcome> {
    const response = await this.fetchImpl(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(this.config.projectId)}/messages:send`,
      {
        method: 'POST',
        headers: {
          authorization: `Bearer ${await this.accessToken()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: message.title, body: message.body },
            data: { url: message.url, tag: message.tag },
            android: {
              priority: 'HIGH',
              notification: { tag: message.tag, channel_id: 'alertas' },
            },
          },
        }),
        signal: AbortSignal.timeout(15_000),
      },
    );
    if (response.ok) return 'SENT';
    const error = (await response.json().catch(() => ({}))) as {
      error?: { status?: string; details?: { errorCode?: string }[] };
    };
    const codes = [error.error?.status, ...(error.error?.details ?? []).map((d) => d.errorCode)];
    if (response.status === 404 || codes.includes('UNREGISTERED')) return 'GONE';
    if (response.status === 400 && codes.includes('INVALID_ARGUMENT')) return 'GONE';
    throw new Error(`O Firebase recusou o push (HTTP ${response.status}).`);
  }
}
