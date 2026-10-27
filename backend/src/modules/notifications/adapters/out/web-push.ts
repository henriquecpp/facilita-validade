import { createCipheriv, createECDH, hkdfSync, randomBytes, type ECDH } from 'node:crypto';
import { importJWK, SignJWT, type CryptoKey, type KeyObject } from 'jose';
import type { PushMessage } from '../../domain/push.js';

/**
 * Web Push sem biblioteca: identificação do servidor por VAPID (RFC 8292) e conteúdo cifrado
 * em aes128gcm (RFC 8291 e RFC 8188), com o node:crypto e o jose que o servidor já usa.
 *
 * As chaves VAPID identificam este servidor nos serviços de push dos navegadores. Gere uma
 * vez com `node scripts/web-push-keys.mjs`; trocar a chave invalida as inscrições feitas.
 */
export interface VapidConfig {
  /** Ponto público P-256 não comprimido (65 bytes), em base64url. Vai para o navegador. */
  readonly publicKey: string;
  /** Escalar privado P-256 (32 bytes), em base64url. */
  readonly privateKey: string;
  /** Contato do responsável pelo servidor: `mailto:` ou `https:`. */
  readonly subject: string;
}

const base64url = (value: Uint8Array) => Buffer.from(value).toString('base64url');
const decode = (value: string) => Buffer.from(value, 'base64url');

export function vapidFromEnv(env: NodeJS.ProcessEnv = process.env): VapidConfig | null {
  const publicKey = env.WEB_PUSH_PUBLIC_KEY?.trim();
  const privateKey = env.WEB_PUSH_PRIVATE_KEY?.trim();
  if (!publicKey && !privateKey) return null;
  if (!publicKey || !privateKey)
    throw new Error('Informe WEB_PUSH_PUBLIC_KEY e WEB_PUSH_PRIVATE_KEY juntos.');
  const point = decode(publicKey);
  if (point.length !== 65 || point[0] !== 4 || decode(privateKey).length !== 32)
    throw new Error('Chaves VAPID inválidas; gere com node scripts/web-push-keys.mjs.');
  const subject = env.WEB_PUSH_SUBJECT?.trim();
  if (!subject || !/^(mailto:|https:\/\/)/.test(subject))
    throw new Error('Informe WEB_PUSH_SUBJECT com um contato mailto: ou https://.');
  return { publicKey, privateKey, subject };
}

/**
 * Serviços de push dos navegadores aceitos numa inscrição. O servidor faz POST no endereço
 * inscrito: sem esta lista, uma inscrição forjada o faria chamar qualquer endereço.
 */
const PUSH_SERVICES = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];

export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  return (
    url.protocol === 'https:' &&
    !url.username &&
    !url.password &&
    (url.port === '' || url.port === '443') &&
    PUSH_SERVICES.some((pattern) => pattern.test(url.hostname))
  );
}

/**
 * Cifra o conteúdo para a inscrição (RFC 8291): acordo ECDH com uma chave efêmera, segredo
 * de autenticação do navegador e um registro aes128gcm só. `salt` e `ephemeral` existem para
 * os testes com o vetor do RFC.
 */
export function encryptPayload(
  payload: Uint8Array,
  p256dh: string,
  auth: string,
  salt: Buffer = randomBytes(16),
  ephemeral?: ECDH,
): Buffer {
  const receiver = decode(p256dh);
  const secret = decode(auth);
  if (receiver.length !== 65 || receiver[0] !== 4 || secret.length < 16)
    throw new Error('Inscrição Web Push com chaves inválidas.');
  const ecdh = ephemeral ?? createECDH('prime256v1');
  if (!ephemeral) ecdh.generateKeys();
  const sender = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(receiver);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiver, sender]);
  const ikm = Buffer.from(hkdfSync('sha256', shared, secret, keyInfo, 32));
  const cek = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16),
  );
  const nonce = Buffer.from(
    hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12),
  );
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  // Registro único: o conteúdo, o delimitador de último registro (0x02) e nenhum enchimento.
  const body = Buffer.concat([
    cipher.update(Buffer.concat([payload, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = sender.length;
  return Buffer.concat([header, sender, body]);
}

export type PushOutcome = 'SENT' | 'GONE';

export class WebPushSender {
  private key?: Promise<CryptoKey | KeyObject | Uint8Array>;
  constructor(
    readonly vapid: VapidConfig,
    readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    readonly now: () => number = () => Date.now(),
  ) {}

  /** Cabeçalho VAPID: JWT ES256 para o serviço de push daquele endereço, válido por 12 h. */
  async authorization(endpoint: string): Promise<string> {
    const point = decode(this.vapid.publicKey);
    this.key ??= importJWK(
      {
        kty: 'EC',
        crv: 'P-256',
        x: base64url(point.subarray(1, 33)),
        y: base64url(point.subarray(33, 65)),
        d: this.vapid.privateKey,
      },
      'ES256',
    );
    const jwt = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', typ: 'JWT' })
      .setAudience(new URL(endpoint).origin)
      .setExpirationTime(Math.floor(this.now() / 1000) + 12 * 3600)
      .setSubject(this.vapid.subject)
      .sign(await this.key);
    return `vapid t=${jwt}, k=${this.vapid.publicKey}`;
  }

  /** Envia; `GONE` quando o navegador cancelou a inscrição e ela deve ser apagada. */
  async send(
    subscription: { endpoint: string; p256dh: string; auth: string },
    message: PushMessage,
  ): Promise<PushOutcome> {
    if (!isPushServiceEndpoint(subscription.endpoint)) return 'GONE';
    const body = encryptPayload(
      Buffer.from(JSON.stringify(message)),
      subscription.p256dh,
      subscription.auth,
    );
    const response = await this.fetchImpl(subscription.endpoint, {
      method: 'POST',
      headers: {
        authorization: await this.authorization(subscription.endpoint),
        ttl: String(24 * 3600),
        urgency: 'normal',
        'content-encoding': 'aes128gcm',
        'content-type': 'application/octet-stream',
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404 || response.status === 410) return 'GONE';
    if (!response.ok) throw new Error(`Serviço de Web Push respondeu HTTP ${response.status}.`);
    return 'SENT';
  }
}
