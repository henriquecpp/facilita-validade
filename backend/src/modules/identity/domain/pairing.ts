import type { Role } from '../../../shared/domain/context.js';

/**
 * Pareamento de coletor por QR.
 *
 * O proprietário gera no painel um código de uso único para um operador; o coletor
 * lê o QR e recebe uma sessão, sem digitar CNPJ, usuário e senha no teclado numérico.
 *
 * O QR carrega só um segredo aleatório de 256 bits — nunca a senha. O servidor guarda
 * o hash dele, e o código expira em minutos e vale uma única vez.
 */
export const PAIRING_PREFIX = 'estoque-pair';
export const PAIRING_VERSION = '1';
export const PAIRING_TTL_SECONDS = 120;

// 32 bytes em base64url, o formato do IdentityCrypto.opaqueToken().
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** Conteúdo do QR: prefixo, versão e segredo. O prefixo separa pareamento de código de produto. */
export function formatPairingCode(secret: string): string {
  if (!SECRET.test(secret)) throw new Error('Segredo de pareamento em formato inesperado.');
  return `${PAIRING_PREFIX}:${PAIRING_VERSION}:${secret}`;
}

/** Segredo contido no código, ou null se não for um código de pareamento desta versão. */
export function parsePairingCode(value: string): string | null {
  const parts = value.trim().split(':');
  if (parts.length !== 3) return null;
  const [prefix, version, secret] = parts as [string, string, string];
  if (prefix !== PAIRING_PREFIX || version !== PAIRING_VERSION) return null;
  return SECRET.test(secret) ? secret : null;
}

export type PairingRefusal = 'INACTIVE' | 'NOT_OPERATOR' | 'PASSWORD_PENDING';

/**
 * Por que um usuário não pode ser pareado, ou null se pode.
 *
 * Só operadores: o QR é o caminho mais fácil de entrar, então fica fora do alcance
 * de quem administra a loja — proprietário e gestor entram com senha.
 *
 * Senha provisória pendente bloqueia porque a restrição de troca de senha é
 * recalculada a cada requisição (`AuthService.authenticate`): uma sessão pareada
 * nasceria bloqueada. O operador troca a senha uma vez no painel, com teclado de
 * verdade, e daí em diante usa o QR no coletor.
 */
export function pairingRefusal(user: {
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
}): PairingRefusal | null {
  if (!user.active) return 'INACTIVE';
  if (user.role !== 'OPERATOR') return 'NOT_OPERATOR';
  if (user.mustChangePassword) return 'PASSWORD_PENDING';
  return null;
}
