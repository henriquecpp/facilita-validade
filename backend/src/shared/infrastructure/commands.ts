import { createHash, randomUUID } from 'node:crypto';
import { ApplicationError } from '../domain/context.js';
import { toJson } from './json.js';
import type { PrismaTx } from './prisma.js';
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
export const hashPayload = (value: unknown) =>
  createHash('sha256').update(canonical(value)).digest('hex');
function requireKey(key: string) {
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(key))
    throw new ApplicationError(
      'IDEMPOTENCY_KEY_REQUIRED',
      'Informe uma chave idempotente UUID.',
      400,
    );
}
const conflict = () =>
  new ApplicationError('IDEMPOTENCY_CONFLICT', 'Chave já utilizada por outro comando.', 409);

/**
 * Executa `work` uma vez por chave idempotente. Uma repetição com a mesma chave e o
 * mesmo conteúdo devolve o resultado gravado; com outro conteúdo ou outro autor, é
 * conflito. O lock consultivo serializa repetições concorrentes da mesma chave.
 */
export async function command<T>(
  tx: PrismaTx,
  storeId: string,
  principal: string,
  operation: string,
  key: string,
  payload: unknown,
  work: () => Promise<T>,
): Promise<T> {
  requireKey(key);
  const hash = hashPayload(payload);
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${storeId}:${operation}:${key}`}, 0))`;
  const old = await tx.command_receipts.findUnique({
    where: {
      store_id_operation_idempotency_key: { store_id: storeId, operation, idempotency_key: key },
    },
    select: { principal_id: true, payload_hash: true, result: true },
  });
  if (old) {
    if (old.principal_id !== principal || old.payload_hash !== hash) throw conflict();
    return old.result as T;
  }
  const result = await work();
  await tx.command_receipts.create({
    data: {
      store_id: storeId,
      operation,
      idempotency_key: key,
      principal_id: principal,
      payload_hash: hash,
      result: toJson(result),
    },
    select: { store_id: true },
  });
  return result;
}

export async function audit(
  tx: PrismaTx,
  storeId: string,
  actor: string | null,
  action: string,
  entity: string | null,
  detail: unknown = {},
) {
  await tx.audit_events.create({
    data: {
      id: randomUUID(),
      store_id: storeId,
      actor_id: actor,
      action,
      entity_id: entity,
      detail: toJson(detail),
    },
    select: { id: true },
  });
}
