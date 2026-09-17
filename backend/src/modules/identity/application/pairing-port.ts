import type { Role } from '../../../shared/domain/context.js';
import type { SessionResult } from './auth-service.js';

export interface PairableUser {
  id: string;
  username: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
}

export interface NewPairing {
  id: string;
  userId: string;
  tokenHash: string;
  issuedBy: string;
  expiresAt: Date;
}

export interface ConsumedPairing {
  userId: string;
  issuedBy: string;
}

/** Operações dentro da transação de uma loja, sob RLS. */
export interface PairingRepository {
  user(id: string): Promise<PairableUser | undefined>;
  insert(pairing: NewPairing): Promise<void>;
  /**
   * Consome o pareamento se ainda estiver válido em `now`. Atômico: duas leituras
   * simultâneas do mesmo QR resultam em uma única sessão.
   */
  consume(id: string, now: Date): Promise<ConsumedPairing | undefined>;
  audit(
    actorId: string,
    action: string,
    entityId: string,
    detail?: Record<string, unknown>,
  ): Promise<void>;
}

export interface PairingPersistence {
  /** Antes de conhecer a loja: resolve o código pelo hash, com o papel de pré-autenticação. */
  resolve(tokenHash: string): Promise<{ storeId: string; pairingId: string } | undefined>;
  tenant<T>(storeId: string, action: (repository: PairingRepository) => Promise<T>): Promise<T>;
}

/** Emissão de sessão pela identidade, com as mesmas regras de token do login. */
export interface DeviceSessionIssuer {
  issueDeviceSession(
    storeId: string,
    userId: string,
    detail: Record<string, unknown>,
  ): Promise<SessionResult>;
}
