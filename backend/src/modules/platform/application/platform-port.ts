import type {
  PlatformEvent,
  PlatformOperator,
  PlatformStore,
  PlatformStoreDetail,
} from '../domain/platform.js';

export interface PlatformAdminRecord {
  id: string;
  username: string;
  passwordHash: string;
  mustChangePassword: boolean;
}

export interface PlatformSessionRecord {
  sessionId: string;
  adminId: string;
  username: string;
  mustChangePassword: boolean;
}

export interface NewStore {
  storeId: string;
  cnpj: string;
  name: string;
  ownerId: string;
  username: string;
  usernameNormalized: string;
  passwordHash: string;
  by: PlatformOperator;
}

export interface OwnerAccessRequest {
  storeId: string;
  ownerId: string;
  tokenHash: string;
  disabledPasswordHash: string;
  reason: string;
  by: PlatformOperator;
}

/**
 * Persistência da plataforma. A identidade dela (administradores, sessões, histórico próprio)
 * e a leitura entre lojas ficam nas funções do schema `platform`; o que muda uma loja roda no
 * contexto dessa loja, sob o RLS dela.
 */
export interface PlatformPersistence {
  admin(usernameNormalized: string): Promise<PlatformAdminRecord | undefined>;
  openSession(
    adminId: string,
    tokenHash: string,
    seconds: number,
  ): Promise<{ sessionId: string; expiresAt: string }>;
  session(tokenHash: string): Promise<PlatformSessionRecord | undefined>;
  closeSession(tokenHash: string): Promise<void>;
  /** Falso quando a sessão já não vale. */
  changePassword(sessionId: string, passwordHash: string): Promise<boolean>;
  history(cursor: string | undefined, limit: number): Promise<PlatformEvent[]>;
  stores(): Promise<PlatformStore[]>;
  store(storeId: string): Promise<PlatformStoreDetail | undefined>;
  /** CNPJ já cadastrado: STORE_EXISTS. */
  createStore(input: NewStore): Promise<void>;
  setStoreActive(
    storeId: string,
    active: boolean,
    reason: string,
    by: PlatformOperator,
  ): Promise<'CHANGED' | 'UNCHANGED' | 'NOT_FOUND'>;
  issueOwnerAccess(
    input: OwnerAccessRequest,
  ): Promise<
    | { username: string; expiresAt: string }
    | 'STORE_NOT_FOUND'
    | 'STORE_SUSPENDED'
    | 'OWNER_NOT_FOUND'
  >;
}

export interface PlatformCrypto {
  hashPassword(password: string): Promise<string>;
  verifyPassword(passwordHash: string, password: string): Promise<boolean>;
  /** Mesmo custo de uma conferência real, para quem não existe. */
  dummyVerify(password: string): Promise<void>;
  opaqueToken(): string;
  hashToken(token: string): string;
  uuid(): string;
  /** Senha provisória legível, para o proprietário digitar no primeiro acesso. */
  temporaryPassword(): string;
}

/** O token da Pagonet é da aplicação: o painel só mostra se existe e se a Pagonet o aceita. */
export interface PagonetGateway {
  readonly configured: boolean;
  check(): Promise<{ ok: true; userName: string | null } | { ok: false; message: string }>;
}
