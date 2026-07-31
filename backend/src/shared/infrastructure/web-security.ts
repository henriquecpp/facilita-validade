import { createHash } from 'node:crypto';
import { ApplicationError } from '../domain/context.js';

export interface CookieOptions {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict';
  path: string;
  maxAge?: number;
}
export interface CookieReply {
  setCookie(name: string, value: string, options: CookieOptions): unknown;
  clearCookie(name: string, options: CookieOptions): unknown;
  header(name: string, value: string): unknown;
}
export interface WebRequest {
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
  ip?: string;
}

/**
 * Cookie de sessão do navegador: HttpOnly e SameSite=Strict. Fora do desenvolvimento em
 * HTTP local, também Secure e com o prefixo `__Host-` (sem Domain, Path=/).
 */
export function sessionCookie(base: string) {
  const secure = process.env.NODE_ENV !== 'development';
  return {
    name: secure ? `__Host-${base}` : base,
    options: { httpOnly: true, secure, sameSite: 'strict' as const, path: '/' },
  };
}

/**
 * Pedido do navegador que vale por um cookie: só da origem do painel e com um cabeçalho que
 * o formulário de outro site não consegue enviar.
 */
export function requireSameOrigin(request: WebRequest) {
  // Uma ou mais origens exatas, separadas por vírgula. Em desenvolvimento o painel
  // responde por localhost e por 127.0.0.1, e para o navegador são origens diferentes.
  const allowed = (process.env.WEB_ORIGIN ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const origin = request.headers.origin;
  if (
    typeof origin !== 'string' ||
    !allowed.includes(origin) ||
    request.headers['x-csrf-protection'] !== '1'
  )
    throw new ApplicationError('CSRF_REJECTED', 'Origem ou proteção CSRF inválida.', 403);
}

/** Chave de limite para uma credencial: guarda o hash, nunca o texto. */
export const credentialKey = (value: string) =>
  `credential:${createHash('sha256').update(value).digest('hex')}`;

const tooMany = () =>
  new ApplicationError('AUTH_RATE_LIMIT', 'Muitas tentativas. Aguarde um minuto.', 429);

/**
 * Tentativas por minuto na memória do processo; cada chave tem o próprio teto. Vale para uma
 * instância da API: com várias, o limite compartilhado vai para o proxy.
 */
export class AttemptLimiter {
  private readonly attempts = new Map<string, { count: number; expires: number }>();
  hit(keys: readonly (readonly [string, number])[]) {
    const now = Date.now();
    if (this.attempts.size > 10000)
      for (const [key, value] of this.attempts) if (value.expires <= now) this.attempts.delete(key);
    for (const [key, maximum] of keys) {
      const current = this.attempts.get(key);
      if ((!current || current.expires <= now) && this.attempts.size >= 12000) throw tooMany();
      const entry = current && current.expires > now ? current : { count: 0, expires: now + 60000 };
      entry.count++;
      this.attempts.set(key, entry);
      if (entry.count > maximum) throw tooMany();
    }
  }
}
