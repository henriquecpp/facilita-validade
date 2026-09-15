import {
  canonicalEventKey,
  timestampMicros,
  type InventoryMovement,
} from '../../inventory/domain/index.js';

export interface AllocatedMovement {
  recordId: string;
  quantity: number;
  movement: InventoryMovement;
}

/**
 * Lê as alocações da projeção final. Nunca redistribui uma venda nem usa ordem de chegada
 * ou UUID do movimento como desempate: reutiliza a chave canônica do motor.
 */
export function lastAllocations(
  rows: readonly AllocatedMovement[],
): Map<string, AllocatedMovement> {
  const result = new Map<string, AllocatedMovement>();
  for (const row of rows) {
    const previous = result.get(row.recordId);
    const time = timestampMicros(row.movement.occurredAt);
    const previousTime = previous ? timestampMicros(previous.movement.occurredAt) : null;
    if (
      !previous ||
      time > previousTime! ||
      (time === previousTime &&
        canonicalEventKey(row.movement) > canonicalEventKey(previous.movement))
    )
      result.set(row.recordId, row);
  }
  return result;
}
