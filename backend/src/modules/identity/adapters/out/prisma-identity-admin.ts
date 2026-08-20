import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { hash, argon2id } from 'argon2';
import type { PrismaClient } from '../../../../generated/prisma/client.js';
import type { PrismaTx } from '../../../../shared/infrastructure/prisma.js';
import { ApplicationError } from '../../../../shared/domain/context.js';
import { normalizeCnpj, normalizeUsername, validatePassword } from '../../domain/identity.js';
import { issueOwnerReset, provisionStore } from './store-provisioning.js';

const passwordHash = (value: string) =>
  hash(value, { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
function requiredText(value: string, field: string, maximum: number) {
  const text = value.trim();
  if (!text || text.length > maximum)
    throw new ApplicationError(
      'INVALID_ADMIN_INPUT',
      `${field} deve conter de 1 a ${maximum} caracteres.`,
      400,
    );
  return text;
}

/**
 * Porta administrativa: exige uma credencial própria de provisionamento, nunca o
 * pool de runtime da API. Esse papel não passa pelo RLS, então cada consulta filtra
 * a loja explicitamente.
 */
export class PrismaIdentityAdmin {
  constructor(private readonly client: PrismaClient) {}
  private transaction<T>(work: (tx: PrismaTx) => Promise<T>) {
    return this.client.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('statement_timeout', '15000', true),
          set_config('lock_timeout', '5000', true)`;
        return work(tx);
      },
      { maxWait: 5000, timeout: 20000 },
    );
  }
  async provision(input: {
    cnpj: string;
    storeName: string;
    username: string;
    temporaryPassword: string;
    operator: string;
  }) {
    const cnpj = normalizeCnpj(input.cnpj),
      username = normalizeUsername(input.username);
    const storeName = requiredText(input.storeName, 'Nome da loja', 160);
    const operator = requiredText(input.operator, 'Identificação administrativa', 160);
    validatePassword(input.temporaryPassword);
    const secret = await passwordHash(input.temporaryPassword);
    return this.transaction(async (tx) => {
      // CNPJ repetido aborta tudo. Rodar de novo nunca altera credenciais existentes.
      const storeId = randomUUID(),
        userId = randomUUID();
      await provisionStore(tx, {
        storeId,
        cnpj,
        storeName,
        ownerId: userId,
        username: input.username.trim(),
        usernameNormalized: username,
        passwordHash: secret,
        by: { operator },
      });
      return { storeId, cnpj, userId, username, mustChangePassword: true };
    });
  }
  async recoverOwner(input: { cnpj: string; username: string; operator: string; reason: string }) {
    const cnpj = normalizeCnpj(input.cnpj),
      username = normalizeUsername(input.username);
    const operator = requiredText(input.operator, 'Identificação administrativa', 160);
    const reason = requiredText(input.reason, 'Motivo da recuperação', 500);
    const resetToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(resetToken).digest('hex');
    const disabledPassword = await passwordHash(randomBytes(32).toString('base64url'));
    return this.transaction(async (tx) => {
      const [store] = await tx.$queryRaw<{ id: string; active: boolean }[]>`
        SELECT id, active FROM stores WHERE cnpj_normalized = ${cnpj} FOR UPDATE`;
      if (!store?.active)
        throw new ApplicationError('STORE_NOT_FOUND', 'Loja ativa não encontrada.', 404);
      const owner = await tx.store_users.findFirst({
        where: { store_id: store.id, username_normalized: username, active: true, role: 'OWNER' },
        select: { id: true },
      });
      if (!owner)
        throw new ApplicationError(
          'OWNER_NOT_FOUND',
          'Proprietário ativo não encontrado nessa loja.',
          404,
        );
      const expiresAt = await issueOwnerReset(tx, {
        storeId: store.id,
        ownerId: owner.id,
        username,
        tokenHash,
        disabledPasswordHash: disabledPassword,
        reason,
        by: { operator },
      });
      return { storeId: store.id, cnpj, username, resetToken, expiresAt };
    });
  }
}
