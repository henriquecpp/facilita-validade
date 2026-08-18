import type {
  DeviceSession,
  IdentitySession,
  IdentityStore,
  IdentityUser,
  PasswordReset,
  RefreshToken,
  RevokeReason,
} from '../domain/identity.js';
import type { Role, TenantActor } from '../../../shared/domain/context.js';

export interface IdentityRepository {
  store(lock?: boolean): Promise<IdentityStore | undefined>;
  user(id: string): Promise<IdentityUser | undefined>;
  users(): Promise<IdentityUser[]>;
  insertUser(user: IdentityUser): Promise<void>;
  updateUser(
    id: string,
    values: {
      username?: string;
      usernameNormalized?: string;
      passwordHash?: string;
      role?: Role;
      active?: boolean;
      mustChangePassword?: boolean;
    },
  ): Promise<void>;
  session(id: string): Promise<IdentitySession | undefined>;
  insertSession(session: IdentitySession): Promise<void>;
  revokeSession(id: string, reason?: RevokeReason): Promise<void>;
  revokeUserSessions(userId: string, reason?: RevokeReason): Promise<void>;
  /** Sessões de coletor ainda válidas, da usada mais recentemente à mais antiga. */
  deviceSessions(): Promise<DeviceSession[]>;
  refresh(hash: string): Promise<RefreshToken | undefined>;
  insertRefresh(token: RefreshToken): Promise<void>;
  /** Marca o token como trocado; falso se ele já tinha sido trocado. */
  consumeRefresh(id: string): Promise<boolean>;
  /** Se outro token da mesma sessão foi trocado depois deste: a cadeia andou sem ele. */
  refreshRotatedAfter(id: string): Promise<boolean>;
  reset(hash: string): Promise<PasswordReset | undefined>;
  insertReset(token: PasswordReset): Promise<void>;
  consumeUserResets(userId: string): Promise<void>;
  audit(
    actorId: string | null,
    action: string,
    entityId: string,
    detail?: Record<string, unknown>,
  ): Promise<void>;
}
export interface IdentityPersistence {
  resolveLogin(
    cnpj: string,
    username: string,
  ): Promise<{ storeId: string; userId: string; passwordHash: string } | undefined>;
  resolveRefresh(hash: string): Promise<{ storeId: string; sessionId: string } | undefined>;
  resolveReset(hash: string): Promise<{ storeId: string; userId: string } | undefined>;
  tenant<T>(storeId: string, action: (repository: IdentityRepository) => Promise<T>): Promise<T>;
}
export interface IdentityCrypto {
  hashPassword(password: string): Promise<string>;
  verifyPassword(hash: string, password: string): Promise<boolean>;
  dummyVerify(password: string): Promise<void>;
  opaqueToken(): string;
  hashToken(token: string): string;
  uuid(): string;
  sign(actor: TenantActor, expiresInSeconds: number): Promise<string>;
  verify(token: string): Promise<{ storeId: string; userId: string; sessionId: string }>;
}
export interface IdentityClock {
  now(): Date;
}
