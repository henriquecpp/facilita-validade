import { ApplicationError, type Role } from '../../../shared/domain/context.js';

/**
 * Quem está no painel da plataforma: opera o serviço para todas as lojas e não pertence a
 * nenhuma. Identidade à parte da dos usuários das lojas — outra tabela, outra sessão.
 */
export interface PlatformActor {
  adminId: string;
  username: string;
  sessionId: string;
  mustChangePassword: boolean;
}

export interface PlatformAdmin {
  id: string;
  username: string;
  mustChangePassword: boolean;
}

/** Quem fez uma operação numa loja; vai para o histórico dela. */
export interface PlatformOperator {
  operator: string;
  adminId?: string;
}

export interface PlatformStore {
  id: string;
  cnpj: string;
  name: string;
  timezone: string;
  active: boolean;
  createdAt: string;
  activeUsers: number;
  owners: string[];
  /** Sem leitura da Pagonet configurada, null. */
  pagonet: { active: boolean; salesThrough: string | null; lastError: string | null } | null;
  lastImportAt: string | null;
}

export interface PlatformStoreUser {
  id: string;
  username: string;
  role: Role;
  active: boolean;
  mustChangePassword: boolean;
}

export interface PlatformStoreDetail extends Omit<PlatformStore, 'pagonet'> {
  users: PlatformStoreUser[];
  pagonet: {
    active: boolean;
    catalogSyncedAt: string | null;
    catalogProducts: number | null;
    salesSyncedAt: string | null;
    salesThrough: string | null;
    lastError: string | null;
    lastErrorAt: string | null;
  } | null;
}

export interface PlatformEvent {
  id: string;
  createdAt: string;
  action: string;
  operator: string | null;
  store: { id: string; name: string } | null;
  /** Só o que o painel mostra; o detalhe guardado pode ter mais. */
  detail: { reason?: string; username?: string; cnpj?: string };
}

/** Sessão do painel da plataforma: um expediente. Depois dele, entrar de novo. */
export const PLATFORM_SESSION_SECONDS = 8 * 3600;

export function requireReason(value: string): string {
  const text = value.trim();
  if (text.length < 3 || text.length > 500)
    throw new ApplicationError('INVALID_REASON', 'Informe o motivo, de 3 a 500 caracteres.', 400);
  return text;
}

export function normalizeStoreName(value: string): string {
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text || text.length > 160)
    throw new ApplicationError(
      'INVALID_STORE_NAME',
      'O nome da loja deve ter de 1 a 160 caracteres.',
      400,
    );
  return text;
}

/** O detalhe do histórico que o painel mostra: só textos conhecidos. */
export function eventDetail(detail: unknown): PlatformEvent['detail'] {
  const source = detail && typeof detail === 'object' ? (detail as Record<string, unknown>) : {};
  const picked: PlatformEvent['detail'] = {};
  for (const key of ['reason', 'username', 'cnpj'] as const)
    if (typeof source[key] === 'string') picked[key] = source[key];
  return picked;
}
