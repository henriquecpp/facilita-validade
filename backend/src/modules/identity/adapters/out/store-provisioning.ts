import { randomUUID } from 'node:crypto';
import type { PrismaTx } from '../../../../shared/infrastructure/prisma.js';
import { iso } from '../../../../shared/infrastructure/instants.js';

/**
 * Quem fez a operação de plataforma: o administrador do painel (com o id) ou a
 * identificação informada no CLI. Vai para o histórico da loja, que também alimenta o
 * histórico da plataforma.
 */
export interface PlatformOperator {
  operator: string;
  adminId?: string;
}

const operatorDetail = (by: PlatformOperator) => ({
  operator: by.operator,
  ...(by.adminId ? { adminId: by.adminId } : {}),
});

/**
 * Cria a loja com as configurações padrão e o proprietário com senha provisória, e registra
 * no histórico dela, numa transação só. CNPJ repetido aborta tudo pelo índice único.
 *
 * Roda tanto com a credencial de provisionamento do CLI quanto no contexto da própria loja
 * nova (`tenant(storeId)`), sob RLS: toda linha leva o `store_id` explícito.
 */
export async function provisionStore(
  tx: PrismaTx,
  input: {
    storeId: string;
    cnpj: string;
    storeName: string;
    ownerId: string;
    username: string;
    usernameNormalized: string;
    passwordHash: string;
    by: PlatformOperator;
  },
) {
  await tx.stores.create({
    data: { id: input.storeId, cnpj_normalized: input.cnpj, name: input.storeName },
    select: { id: true },
  });
  await tx.store_settings.create({ data: { store_id: input.storeId }, select: { store_id: true } });
  await tx.store_users.create({
    data: {
      id: input.ownerId,
      store_id: input.storeId,
      username: input.username,
      username_normalized: input.usernameNormalized,
      password_hash: input.passwordHash,
      role: 'OWNER',
      must_change_password: true,
    },
    select: { id: true },
  });
  await tx.audit_events.create({
    data: {
      id: randomUUID(),
      store_id: input.storeId,
      action: 'PLATFORM_STORE_PROVISIONED',
      entity_id: input.ownerId,
      detail: { ...operatorDetail(input.by), username: input.usernameNormalized, cnpj: input.cnpj },
    },
    select: { id: true },
  });
}

/**
 * Acesso novo para um proprietário que perdeu o dele: encerra as sessões, invalida a senha e
 * os links anteriores e emite um link de uso único por 30 minutos. O token em claro sai só
 * para quem pediu; aqui entra o hash. Devolve quando o link vence.
 */
export async function issueOwnerReset(
  tx: PrismaTx,
  input: {
    storeId: string;
    ownerId: string;
    username: string;
    tokenHash: string;
    disabledPasswordHash: string;
    reason: string;
    by: PlatformOperator;
  },
): Promise<string> {
  const { storeId, ownerId } = input;
  await tx.$executeRaw`
    UPDATE auth_sessions SET revoked_at = COALESCE(revoked_at, clock_timestamp())
     WHERE store_id = ${storeId}::uuid AND user_id = ${ownerId}::uuid`;
  await tx.$executeRaw`
    UPDATE password_reset_tokens SET consumed_at = COALESCE(consumed_at, clock_timestamp())
     WHERE store_id = ${storeId}::uuid AND user_id = ${ownerId}::uuid`;
  await tx.store_users.updateMany({
    where: { store_id: storeId, id: ownerId },
    data: {
      password_hash: input.disabledPasswordHash,
      must_change_password: true,
      credential_version: { increment: 1 },
      version: { increment: 1 },
    },
  });
  const [token] = await tx.$queryRaw<{ expiresAt: Date }[]>`
    INSERT INTO password_reset_tokens(id, store_id, user_id, token_hash, expires_at)
    VALUES (${randomUUID()}::uuid, ${storeId}::uuid, ${ownerId}::uuid, ${input.tokenHash},
            clock_timestamp() + interval '30 minutes')
    RETURNING expires_at AS "expiresAt"`;
  await tx.audit_events.create({
    data: {
      id: randomUUID(),
      store_id: storeId,
      action: 'PLATFORM_OWNER_RESET_ISSUED',
      entity_id: ownerId,
      detail: { ...operatorDetail(input.by), reason: input.reason, username: input.username },
    },
    select: { id: true },
  });
  return iso(token!.expiresAt);
}
