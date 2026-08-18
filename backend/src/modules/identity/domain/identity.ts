import { ApplicationError, type Role } from '../../../shared/domain/context.js';

export function normalizeCnpj(input: string): string {
  const value = input
    .trim()
    .toUpperCase()
    .replace(/[./\-\s]/g, '');
  if (!/^[A-Z0-9]{12}[0-9]{2}$/.test(value) || /^(\d)\1{13}$/.test(value))
    throw new ApplicationError('INVALID_CNPJ', 'CNPJ inválido.', 400);
  const digit = (base: string): number => {
    let weight = 2,
      sum = 0;
    for (let i = base.length - 1; i >= 0; i--) {
      sum += (base.charCodeAt(i) - 48) * weight;
      weight = weight === 9 ? 2 : weight + 1;
    }
    const remainder = sum % 11;
    return remainder < 2 ? 0 : 11 - remainder;
  };
  const first = digit(value.slice(0, 12));
  if (Number(value[12]) !== first || Number(value[13]) !== digit(value.slice(0, 12) + first))
    throw new ApplicationError('INVALID_CNPJ', 'CNPJ inválido.', 400);
  return value;
}

export function normalizeUsername(input: string): string {
  const value = input.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(value))
    throw new ApplicationError(
      'INVALID_USERNAME',
      'Usuário deve ter de 3 a 64 letras, números, pontos, hífens ou sublinhados.',
      400,
    );
  return value;
}
export function validatePassword(password: string): void {
  if (password.length < 12 || password.length > 128)
    throw new ApplicationError('INVALID_PASSWORD', 'A senha deve ter de 12 a 128 caracteres.', 400);
}
export interface IdentityUser {
  id: string;
  storeId: string;
  username: string;
  usernameNormalized: string;
  passwordHash: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
  version: number;
}
export interface IdentityStore {
  id: string;
  name: string;
  cnpj: string;
  active: boolean;
}
export interface IdentitySession {
  id: string;
  storeId: string;
  userId: string;
  client: 'web' | 'mobile';
  restricted: boolean;
  expiresAt: string;
  revokedAt: string | null;
  /** 'ADMIN' quando o proprietário encerrou a sessão; nulo se o próprio usuário saiu. */
  revokedReason?: RevokeReason | null;
}
export type RevokeReason = 'ADMIN';
/** Coletor com sessão aberta, como o proprietário vê no painel. */
export interface DeviceSession {
  id: string;
  userId: string;
  username: string;
  startedAt: string;
  /** Última renovação da sessão, que o coletor faz enquanto é usado; sem renovação, o login. */
  lastActiveAt: string;
}
export interface RefreshToken {
  id: string;
  sessionId: string;
  tokenHash: string;
  expiresAt: string;
  consumedAt: string | null;
}
export interface PasswordReset {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: string;
  consumedAt: string | null;
}
export function publicUser(user: IdentityUser) {
  return {
    id: user.id,
    storeId: user.storeId,
    username: user.username,
    role: user.role,
    active: user.active,
    mustChangePassword: user.mustChangePassword,
    version: user.version,
  };
}
