import type { ConfirmCountInput, InventoryBaseline, StockRecord } from './types.js';
import {
  assertQuantity,
  assertStockRecord,
  compareText,
  compareTimestamps,
  invariant,
  normalizeLotCode,
  safeQuantitySum,
  timestampMicros,
} from './validation.js';

/**
 * Build the absolute replacement snapshot after the adapter has locked the product and
 * verified session state/version/actor. cutoffAt is the server instant of the last saved
 * line (or of the confirmation, without lines). Movements during the count never block it:
 * the replay reports them as countWindowQuantity. The transaction must persist the returned
 * epoch plus its initial projection. Consolidation keeps the earliest line's stable
 * ID/priority; no UUID is generated.
 */
export function confirmCount(input: ConfirmCountInput): InventoryBaseline {
  invariant(
    input.completeProductConfirmed,
    'INCOMPLETE_COUNT',
    'A count must cover the complete product stock',
  );
  invariant(
    timestampMicros(input.countStartedAt) <= timestampMicros(input.cutoffAt),
    'INVALID_COUNT_WINDOW',
    'Count cutoff cannot precede its start',
  );
  const ids = new Set<string>();
  const groups = new Map<string, StockRecord>();
  for (const line of input.lines) {
    assertStockRecord(line, input.storeId, input.productId);
    invariant(!ids.has(line.id), 'DUPLICATE_COUNT_LINE', 'Submit each versioned count line once');
    invariant(
      compareTimestamps(line.allocationPriorityAt, input.cutoffAt) <= 0,
      'INVALID_RECORD_PRIORITY',
      'A count line cannot be launched after its cutoff',
    );
    ids.add(line.id);
    const lotCode = normalizeLotCode(line.lotCode);
    const key = JSON.stringify([line.expiresOn, lotCode]);
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, { ...line, lotCode });
      continue;
    }
    const quantity = safeQuantitySum(existing.quantity, line.quantity);
    assertQuantity(quantity, true);
    const first =
      compareTimestamps(existing.allocationPriorityAt, line.allocationPriorityAt) < 0 ||
      (compareTimestamps(existing.allocationPriorityAt, line.allocationPriorityAt) === 0 &&
        compareText(existing.id, line.id) <= 0)
        ? existing
        : line;
    groups.set(key, { ...first, lotCode, quantity });
  }
  const records = [...groups.values()].sort((a, b) => compareText(a.id, b.id));
  const total = records.reduce((sum, record) => safeQuantitySum(sum, record.quantity), 0);
  invariant(
    total > 0 || input.emptyProductConfirmed,
    'EMPTY_COUNT_NOT_CONFIRMED',
    'Explicitly confirm that the product has no units',
  );
  return {
    id: input.baselineId,
    storeId: input.storeId,
    productId: input.productId,
    cutoffAt: input.cutoffAt,
    countStartedAt: input.countStartedAt,
    records,
  };
}

/** Validate on receipt; replay itself can safely carry any future fact as pending. */
export function classifyMovementTime(
  occurredAt: string,
  receivedAt: string,
): 'READY' | 'PENDING_FUTURE' {
  const delta = timestampMicros(occurredAt) - timestampMicros(receivedAt);
  invariant(
    delta <= 300_000_000n,
    'EVENT_TOO_FAR_IN_FUTURE',
    'Event is more than five minutes in the future',
  );
  return delta > 0n ? 'PENDING_FUTURE' : 'READY';
}
