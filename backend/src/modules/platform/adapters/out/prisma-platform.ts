import { randomUUID } from 'node:crypto';
import { ApplicationError, type Role } from '../../../../shared/domain/context.js';
import type { PrismaDatabase } from '../../../../shared/infrastructure/prisma.js';
import { sqlState } from '../../../../shared/infrastructure/database-errors.js';
import { iso, isoOrNull } from '../../../../shared/infrastructure/instants.js';
import {
  issueOwnerReset,
  provisionStore,
} from '../../../identity/adapters/out/store-provisioning.js';
import {
  eventDetail,
  type PlatformEvent,
  type PlatformOperator,
  type PlatformStore,
  type PlatformStoreDetail,
} from '../../domain/platform.js';
import type {
  NewStore,
  OwnerAccessRequest,
  PlatformAdminRecord,
  PlatformPersistence,
  PlatformSessionRecord,
} from '../../application/platform-port.js';

interface StoreRow {
  id: string;
  cnpj: string;
  name: string;
  timezone: string;
  active: boolean;
  created_at: Date;
}

/**
 * Duas vias, de propósito:
 *
 * - `prisma.auth` (papel app_auth) chama as funções SECURITY DEFINER do schema `platform`:
 *   identidade da plataforma, histórico e a lista de lojas, só com metadados.
 * - `prisma.tenant(loja)` (papel app_runtime, sob RLS) faz o que muda uma loja ou lê o
 *   detalhe dela. O banco garante que cada operação toca só aquela loja, e o histórico da
 *   loja registra a mudança na mesma transação.
 */
export class PrismaPlatform implements PlatformPersistence {
  constructor(private readonly prisma: PrismaDatabase) {}

  async admin(usernameNormalized: string): Promise<PlatformAdminRecord | undefined> {
    const [row] = await this.prisma.auth.$queryRaw<
      { id: string; username: string; password_hash: string; must_change_password: boolean }[]
    >`SELECT * FROM platform.resolve_admin(${usernameNormalized})`;
    return (
      row && {
        id: row.id,
        username: row.username,
        passwordHash: row.password_hash,
        mustChangePassword: row.must_change_password,
      }
    );
  }

  async openSession(adminId: string, tokenHash: string, seconds: number) {
    const [row] = await this.prisma.auth.$queryRaw<{ session_id: string; expires_at: Date }[]>`
      SELECT * FROM platform.open_session(${adminId}::uuid, ${tokenHash}, ${seconds}::integer)`;
    return { sessionId: row!.session_id, expiresAt: iso(row!.expires_at) };
  }

  async session(tokenHash: string): Promise<PlatformSessionRecord | undefined> {
    const [row] = await this.prisma.auth.$queryRaw<
      { session_id: string; admin_id: string; username: string; must_change_password: boolean }[]
    >`SELECT * FROM platform.resolve_session(${tokenHash})`;
    return (
      row && {
        sessionId: row.session_id,
        adminId: row.admin_id,
        username: row.username,
        mustChangePassword: row.must_change_password,
      }
    );
  }

  async closeSession(tokenHash: string) {
    // A função não devolve nada: executar basta, sem ler coluna do tipo void.
    await this.prisma.auth.$executeRaw`SELECT platform.close_session(${tokenHash})`;
  }

  async changePassword(sessionId: string, passwordHash: string) {
    const [row] = await this.prisma.auth.$queryRaw<{ changed: boolean }[]>`
      SELECT platform.change_password(${sessionId}::uuid, ${passwordHash}) AS changed`;
    return !!row?.changed;
  }

  async history(cursor: string | undefined, limit: number): Promise<PlatformEvent[]> {
    const rows = await this.prisma.auth.$queryRaw<
      {
        id: string;
        created_at: Date;
        action: string;
        operator: string | null;
        store_id: string | null;
        store_name: string | null;
        detail: unknown;
      }[]
    >`SELECT * FROM platform.history(${cursor ?? null}::uuid, ${limit}::integer)`;
    return rows.map((row) => ({
      id: row.id,
      createdAt: iso(row.created_at),
      action: row.action,
      operator: row.operator,
      store: row.store_id ? { id: row.store_id, name: row.store_name ?? '' } : null,
      detail: eventDetail(row.detail),
    }));
  }

  async stores(): Promise<PlatformStore[]> {
    const rows = await this.prisma.auth.$queryRaw<
      (StoreRow & {
        active_users: number;
        owners: string[];
        pagonet_active: boolean | null;
        sales_through: string | null;
        pagonet_error: string | null;
        last_import_at: Date | null;
      })[]
    >`SELECT * FROM platform.stores()`;
    return rows.map((row) => ({
      ...summary(row),
      activeUsers: row.active_users,
      owners: row.owners,
      pagonet:
        row.pagonet_active === null
          ? null
          : {
              active: row.pagonet_active,
              salesThrough: row.sales_through,
              lastError: row.pagonet_error,
            },
      lastImportAt: isoOrNull(row.last_import_at),
    }));
  }

  store(storeId: string): Promise<PlatformStoreDetail | undefined> {
    return this.prisma.tenant(
      storeId,
      async (tx) => {
        const [store] = await tx.$queryRaw<StoreRow[]>`
          SELECT id, cnpj_normalized AS cnpj, name, timezone, active, created_at
            FROM stores WHERE id = ${storeId}::uuid`;
        if (!store) return undefined;
        const users = await tx.$queryRaw<
          {
            id: string;
            username: string;
            role: Role;
            active: boolean;
            must_change_password: boolean;
          }[]
        >`SELECT id, username, role, active, must_change_password FROM store_users
           WHERE store_id = ${storeId}::uuid
           ORDER BY active DESC,
                    CASE role WHEN 'OWNER' THEN 0 WHEN 'MANAGER' THEN 1 ELSE 2 END,
                    username_normalized`;
        const [source] = await tx.$queryRaw<
          {
            active: boolean;
            catalog_synced_at: Date | null;
            catalog_products: number | null;
            sales_synced_at: Date | null;
            sales_through: string | null;
            last_error: string | null;
            last_error_at: Date | null;
          }[]
        >`SELECT active, catalog_synced_at, catalog_products, sales_synced_at,
                 sales_through, last_error, last_error_at
            FROM pagonet_sources WHERE store_id = ${storeId}::uuid`;
        // Como no painel da loja: o fim do processamento do lote mais recente.
        const [imports] = await tx.$queryRaw<{ last: Date | null }[]>`
          SELECT max(completed_at) AS last FROM import_batches
           WHERE store_id = ${storeId}::uuid`;
        const active = users.filter((user) => user.active);
        return {
          ...summary(store),
          activeUsers: active.length,
          owners: active.filter((user) => user.role === 'OWNER').map((user) => user.username),
          lastImportAt: isoOrNull(imports?.last),
          users: users.map((user) => ({
            id: user.id,
            username: user.username,
            role: user.role,
            active: user.active,
            mustChangePassword: user.must_change_password,
          })),
          pagonet: source
            ? {
                active: source.active,
                catalogSyncedAt: isoOrNull(source.catalog_synced_at),
                catalogProducts: source.catalog_products,
                salesSyncedAt: isoOrNull(source.sales_synced_at),
                salesThrough: source.sales_through,
                lastError: source.last_error,
                lastErrorAt: isoOrNull(source.last_error_at),
              }
            : null,
        };
      },
      { readOnlySnapshot: true },
    );
  }

  async createStore(input: NewStore) {
    try {
      // O contexto é o da loja nova: o RLS só deixa gravar linhas dela.
      await this.prisma.tenant(input.storeId, (tx) =>
        provisionStore(tx, {
          storeId: input.storeId,
          cnpj: input.cnpj,
          storeName: input.name,
          ownerId: input.ownerId,
          username: input.username,
          usernameNormalized: input.usernameNormalized,
          passwordHash: input.passwordHash,
          by: input.by,
        }),
      );
    } catch (error) {
      if (sqlState(error) === '23505')
        throw new ApplicationError('STORE_EXISTS', 'Já existe uma loja com esse CNPJ.', 409);
      throw error;
    }
  }

  setStoreActive(storeId: string, active: boolean, reason: string, by: PlatformOperator) {
    return this.prisma.tenant(storeId, async (tx) => {
      const [store] = await tx.$queryRaw<{ active: boolean }[]>`
        SELECT active FROM stores WHERE id = ${storeId}::uuid FOR UPDATE`;
      if (!store) return 'NOT_FOUND' as const;
      if (store.active === active) return 'UNCHANGED' as const;
      await tx.$executeRaw`UPDATE stores SET active = ${active} WHERE id = ${storeId}::uuid`;
      await tx.audit_events.create({
        data: {
          id: randomUUID(),
          store_id: storeId,
          action: active ? 'PLATFORM_STORE_REACTIVATED' : 'PLATFORM_STORE_SUSPENDED',
          entity_id: storeId,
          detail: { operator: by.operator, ...(by.adminId ? { adminId: by.adminId } : {}), reason },
        },
        select: { id: true },
      });
      return 'CHANGED' as const;
    });
  }

  issueOwnerAccess(input: OwnerAccessRequest) {
    return this.prisma.tenant(input.storeId, async (tx) => {
      const [store] = await tx.$queryRaw<{ active: boolean }[]>`
        SELECT active FROM stores WHERE id = ${input.storeId}::uuid FOR UPDATE`;
      if (!store) return 'STORE_NOT_FOUND' as const;
      if (!store.active) return 'STORE_SUSPENDED' as const;
      const owner = await tx.store_users.findFirst({
        where: { store_id: input.storeId, id: input.ownerId, active: true, role: 'OWNER' },
        select: { username: true, username_normalized: true },
      });
      if (!owner) return 'OWNER_NOT_FOUND' as const;
      const expiresAt = await issueOwnerReset(tx, {
        storeId: input.storeId,
        ownerId: input.ownerId,
        username: owner.username_normalized,
        tokenHash: input.tokenHash,
        disabledPasswordHash: input.disabledPasswordHash,
        reason: input.reason,
        by: input.by,
      });
      return { username: owner.username, expiresAt };
    });
  }
}

const summary = (row: StoreRow) => ({
  id: row.id,
  cnpj: row.cnpj,
  name: row.name,
  timezone: row.timezone,
  active: row.active,
  createdAt: iso(row.created_at),
});
