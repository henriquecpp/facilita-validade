import type { PrismaDatabase, PrismaTx } from '../../../../shared/infrastructure/prisma.js';
import { audit } from '../../../../shared/infrastructure/commands.js';
import { iso, isoOrNull } from '../../../../shared/infrastructure/instants.js';
import type { Role } from '../../../../shared/domain/context.js';
import type { IdentityPersistence, IdentityRepository } from '../../application/identity-port.js';
import type {
  DeviceSession,
  IdentitySession,
  IdentityStore,
  IdentityUser,
  PasswordReset,
  RefreshToken,
  RevokeReason,
} from '../../domain/identity.js';

/**
 * Apaga os refresh tokens vencidos há mais de 7 dias. Cada renovação de sessão grava um
 * token novo, então um coletor ativo gera dezenas por dia; a folga de 7 dias mantém os
 * recentes para diagnóstico de reúso. Devolve quantos foram apagados.
 */
export function purgeExpiredRefreshTokens(tx: PrismaTx, storeId: string): Promise<number> {
  return tx.$executeRaw`
    DELETE FROM refresh_tokens
     WHERE store_id = ${storeId}::uuid AND expires_at < clock_timestamp() - interval '7 days'`;
}

export class PrismaIdentityPersistence implements IdentityPersistence {
  constructor(private readonly prisma: PrismaDatabase) {}
  // As três resoluções rodam antes de haver loja no contexto: só as funções
  // SECURITY DEFINER de `auth` enxergam as tabelas, e cada uma devolve uma linha.
  async resolveLogin(cnpj: string, username: string) {
    const [row] = await this.prisma.auth.$queryRaw<
      { storeId: string; userId: string; passwordHash: string }[]
    >`SELECT store_id AS "storeId", user_id AS "userId", password_hash AS "passwordHash"
        FROM auth.resolve_login(${cnpj}, ${username})`;
    return row;
  }
  async resolveRefresh(hash: string) {
    const [row] = await this.prisma.auth.$queryRaw<{ storeId: string; sessionId: string }[]>`
      SELECT store_id AS "storeId", session_id AS "sessionId" FROM auth.resolve_refresh(${hash})`;
    return row;
  }
  async resolveReset(hash: string) {
    const [row] = await this.prisma.auth.$queryRaw<{ storeId: string; userId: string }[]>`
      SELECT store_id AS "storeId", user_id AS "userId" FROM auth.resolve_password_reset(${hash})`;
    return row;
  }
  tenant<T>(storeId: string, action: (repository: IdentityRepository) => Promise<T>) {
    return this.prisma.tenant(storeId, (tx) => action(new PrismaIdentityRepository(tx, storeId)));
  }
}

const userFields = {
  id: true,
  store_id: true,
  username: true,
  username_normalized: true,
  password_hash: true,
  role: true,
  active: true,
  must_change_password: true,
  version: true,
} as const;
function toUser(row: {
  id: string;
  store_id: string;
  username: string;
  username_normalized: string;
  password_hash: string;
  role: string;
  active: boolean;
  must_change_password: boolean;
  version: number;
}): IdentityUser {
  return {
    id: row.id,
    storeId: row.store_id,
    username: row.username,
    usernameNormalized: row.username_normalized,
    passwordHash: row.password_hash,
    role: row.role as Role,
    active: row.active,
    mustChangePassword: row.must_change_password,
    version: row.version,
  };
}

class PrismaIdentityRepository implements IdentityRepository {
  constructor(
    private readonly tx: PrismaTx,
    private readonly storeId: string,
  ) {}
  async store(lock = false): Promise<IdentityStore | undefined> {
    // Com trava, serializa as operações de identidade da loja inteira.
    const [row] = lock
      ? await this.tx.$queryRaw<IdentityStore[]>`
          SELECT id, name, cnpj_normalized AS cnpj, active FROM stores
           WHERE id = ${this.storeId}::uuid FOR UPDATE`
      : await this.tx.$queryRaw<IdentityStore[]>`
          SELECT id, name, cnpj_normalized AS cnpj, active FROM stores
           WHERE id = ${this.storeId}::uuid`;
    return row;
  }
  async user(id: string) {
    const row = await this.tx.store_users.findFirst({
      where: { store_id: this.storeId, id },
      select: userFields,
    });
    return row ? toUser(row) : undefined;
  }
  async users() {
    const rows = await this.tx.store_users.findMany({
      where: { store_id: this.storeId },
      orderBy: [{ username_normalized: 'asc' }, { id: 'asc' }],
      select: userFields,
    });
    return rows.map(toUser);
  }
  async insertUser(user: IdentityUser) {
    await this.tx.store_users.create({
      data: {
        id: user.id,
        store_id: this.storeId,
        username: user.username,
        username_normalized: user.usernameNormalized,
        password_hash: user.passwordHash,
        role: user.role,
        active: user.active,
        must_change_password: user.mustChangePassword,
      },
      select: { id: true },
    });
  }
  async updateUser(id: string, values: Parameters<IdentityRepository['updateUser']>[1]) {
    const data = {
      username: values.username,
      username_normalized: values.usernameNormalized,
      password_hash: values.passwordHash,
      role: values.role,
      active: values.active,
      must_change_password: values.mustChangePassword,
    };
    // Nada a mudar não é alteração: versão e credencial ficam como estão.
    if (Object.values(data).every((value) => value === undefined)) return;
    await this.tx.store_users.updateMany({
      where: { store_id: this.storeId, id },
      data: {
        ...data,
        version: { increment: 1 },
        credential_version: { increment: 1 },
      },
    });
  }
  async session(id: string): Promise<IdentitySession | undefined> {
    const row = await this.tx.auth_sessions.findFirst({
      where: { store_id: this.storeId, id },
      select: {
        id: true,
        store_id: true,
        user_id: true,
        client: true,
        restricted: true,
        expires_at: true,
        revoked_at: true,
        revoked_reason: true,
      },
    });
    return row
      ? {
          id: row.id,
          storeId: row.store_id,
          userId: row.user_id,
          client: row.client as IdentitySession['client'],
          restricted: row.restricted,
          expiresAt: iso(row.expires_at),
          revokedAt: isoOrNull(row.revoked_at),
          revokedReason: row.revoked_reason as RevokeReason | null,
        }
      : undefined;
  }
  async insertSession(s: IdentitySession) {
    await this.tx.auth_sessions.create({
      data: {
        id: s.id,
        store_id: this.storeId,
        user_id: s.userId,
        client: s.client,
        restricted: s.restricted,
        expires_at: new Date(s.expiresAt),
      },
      select: { id: true },
    });
  }
  // Revogação e consumo usam o relógio do banco, como os demais instantes gravados.
  // O motivo é o da primeira revogação: encerrar de novo não reescreve quem encerrou.
  async revokeSession(id: string, reason: RevokeReason | null = null) {
    await this.tx.$executeRaw`
      UPDATE auth_sessions
         SET revoked_reason = CASE WHEN revoked_at IS NULL THEN ${reason} ELSE revoked_reason END,
             revoked_at = COALESCE(revoked_at, clock_timestamp())
       WHERE store_id = ${this.storeId}::uuid AND id = ${id}::uuid`;
  }
  async revokeUserSessions(userId: string, reason: RevokeReason | null = null) {
    await this.tx.$executeRaw`
      UPDATE auth_sessions
         SET revoked_reason = CASE WHEN revoked_at IS NULL THEN ${reason} ELSE revoked_reason END,
             revoked_at = COALESCE(revoked_at, clock_timestamp())
       WHERE store_id = ${this.storeId}::uuid AND user_id = ${userId}::uuid`;
  }
  async deviceSessions(): Promise<DeviceSession[]> {
    // A última troca de refresh token marca o último uso: o coletor renova o acesso de 10
    // minutos na primeira chamada depois que ele vence. Sessão provisória (troca de senha) fica
    // de fora.
    const rows = await this.tx.$queryRaw<
      { id: string; userId: string; username: string; startedAt: Date; lastActiveAt: Date }[]
    >`SELECT s.id, s.user_id AS "userId", u.username, s.created_at AS "startedAt",
              GREATEST(s.created_at,
                       (SELECT max(t.consumed_at) FROM refresh_tokens t
                         WHERE t.store_id = s.store_id AND t.session_id = s.id)) AS "lastActiveAt"
         FROM auth_sessions s
         JOIN store_users u ON u.store_id = s.store_id AND u.id = s.user_id
        WHERE s.store_id = ${this.storeId}::uuid AND s.client = 'mobile' AND NOT s.restricted
          AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp() AND u.active
        ORDER BY "lastActiveAt" DESC, s.id`;
    return rows.map((row) => ({
      ...row,
      startedAt: iso(row.startedAt),
      lastActiveAt: iso(row.lastActiveAt),
    }));
  }
  async refresh(hash: string): Promise<RefreshToken | undefined> {
    const row = await this.tx.refresh_tokens.findFirst({
      where: { store_id: this.storeId, token_hash: hash },
      select: { id: true, session_id: true, token_hash: true, expires_at: true, consumed_at: true },
    });
    return row
      ? {
          id: row.id,
          sessionId: row.session_id,
          tokenHash: row.token_hash,
          expiresAt: iso(row.expires_at),
          consumedAt: isoOrNull(row.consumed_at),
        }
      : undefined;
  }
  async insertRefresh(t: RefreshToken) {
    await this.tx.refresh_tokens.create({
      data: {
        id: t.id,
        store_id: this.storeId,
        session_id: t.sessionId,
        token_hash: t.tokenHash,
        expires_at: new Date(t.expiresAt),
      },
      select: { id: true },
    });
  }
  async consumeRefresh(id: string) {
    const updated = await this.tx.$executeRaw`
      UPDATE refresh_tokens SET consumed_at = clock_timestamp()
       WHERE store_id = ${this.storeId}::uuid AND id = ${id}::uuid AND consumed_at IS NULL`;
    return updated > 0;
  }
  async refreshRotatedAfter(id: string) {
    // Comparado no banco, em microssegundos: o instante em texto perderia a precisão.
    const [row] = await this.tx.$queryRaw<{ rotated: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM refresh_tokens t
          JOIN refresh_tokens r ON r.store_id = t.store_id AND r.session_id = t.session_id
         WHERE r.store_id = ${this.storeId}::uuid AND r.id = ${id}::uuid
           AND t.id <> r.id AND t.consumed_at >= r.consumed_at) AS rotated`;
    return row?.rotated ?? true;
  }

  async reset(hash: string): Promise<PasswordReset | undefined> {
    const row = await this.tx.password_reset_tokens.findFirst({
      where: { store_id: this.storeId, token_hash: hash },
      select: { id: true, user_id: true, token_hash: true, expires_at: true, consumed_at: true },
    });
    return row
      ? {
          id: row.id,
          userId: row.user_id,
          tokenHash: row.token_hash,
          expiresAt: iso(row.expires_at),
          consumedAt: isoOrNull(row.consumed_at),
        }
      : undefined;
  }
  async insertReset(t: PasswordReset) {
    await this.tx.password_reset_tokens.create({
      data: {
        id: t.id,
        store_id: this.storeId,
        user_id: t.userId,
        token_hash: t.tokenHash,
        expires_at: new Date(t.expiresAt),
      },
      select: { id: true },
    });
  }
  async consumeUserResets(userId: string) {
    await this.tx.$executeRaw`
      UPDATE password_reset_tokens SET consumed_at = COALESCE(consumed_at, clock_timestamp())
       WHERE store_id = ${this.storeId}::uuid AND user_id = ${userId}::uuid`;
  }
  async audit(
    actorId: string | null,
    action: string,
    entityId: string,
    detail: Record<string, unknown> = {},
  ) {
    await audit(this.tx, this.storeId, actorId, action, entityId, detail);
  }
}
