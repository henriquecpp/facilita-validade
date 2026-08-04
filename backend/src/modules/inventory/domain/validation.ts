import type { StockIdentification, StockRecord } from './types.js';

export const MAX_RECORD_QUANTITY = 1_000_000_000;

export class InventoryDomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'InventoryDomainError';
  }
}

export function invariant(condition: unknown, code: string, message: string): asserts condition {
  if (!condition) throw new InventoryDomainError(code, message);
}

export function assertIdentifier(value: string, label: string): void {
  invariant(
    typeof value === 'string' && value.trim().length > 0,
    'INVALID_IDENTIFIER',
    `${label} is required`,
  );
}

export function assertQuantity(value: number, allowZero = false): void {
  invariant(
    Number.isSafeInteger(value) && value >= (allowZero ? 0 : 1) && value <= MAX_RECORD_QUANTITY,
    'INVALID_QUANTITY',
    `Quantity must be an integer between ${allowZero ? 0 : 1} and ${MAX_RECORD_QUANTITY}`,
  );
}

export function safeQuantitySum(left: number, right: number): number {
  const result = left + right;
  invariant(
    Number.isSafeInteger(result) && result >= 0,
    'QUANTITY_OVERFLOW',
    'Quantity sum exceeds safe integer range',
  );
  return result;
}

export function assertDate(value: string): void {
  invariant(
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value),
    'INVALID_DATE',
    'Expiration requires YYYY-MM-DD',
  );
  const parsed = new Date(`${value}T00:00:00.000Z`);
  invariant(
    !Number.isNaN(parsed.getTime()) &&
      parsed.toISOString().slice(0, 10) === value &&
      value.slice(0, 4) !== '0000',
    'INVALID_DATE',
    'Expiration is not a valid calendar date',
  );
}

/** Preserve PostgreSQL microseconds when ordering facts and comparing an exact cutoff. */
export function timestampMicros(value: string): bigint {
  invariant(typeof value === 'string', 'INVALID_TIMESTAMP', 'Timestamp must be an ISO string');
  const match =
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  invariant(
    match,
    'INVALID_TIMESTAMP',
    'Timestamp requires an explicit timezone and at most six fractional digits',
  );
  const [, date, hour, minute, second, fraction, zone] = match;
  invariant(date && hour && minute && second && zone, 'INVALID_TIMESTAMP', 'Invalid timestamp');
  assertDate(date);
  invariant(
    Number(hour) < 24 && Number(minute) < 60 && Number(second) < 60,
    'INVALID_TIMESTAMP',
    'Invalid clock time',
  );
  if (zone !== 'Z') {
    invariant(
      Number(zone.slice(1, 3)) < 24 && Number(zone.slice(4, 6)) < 60,
      'INVALID_TIMESTAMP',
      'Invalid timezone offset',
    );
  }
  const milliseconds = Date.parse(`${date}T${hour}:${minute}:${second}${zone}`);
  invariant(Number.isFinite(milliseconds), 'INVALID_TIMESTAMP', 'Invalid timestamp');
  return BigInt(milliseconds) * 1_000n + BigInt((fraction ?? '').padEnd(6, '0'));
}

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function compareTimestamps(left: string, right: string): number {
  const a = timestampMicros(left);
  const b = timestampMicros(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

export function normalizeLotCode(value?: string | null): string | null {
  invariant(
    value === undefined || value === null || typeof value === 'string',
    'INVALID_LOT_CODE',
    'Lot code must be text',
  );
  return value?.normalize('NFC').trim() || null;
}

export function assertIdentification(identification?: StockIdentification): void {
  if (!identification) return;
  if (identification.stockRecordId !== undefined)
    assertIdentifier(identification.stockRecordId, 'stockRecordId');
  if (identification.expiresOn !== undefined) assertDate(identification.expiresOn);
  normalizeLotCode(identification.lotCode);
}

export function assertScope(
  value: { storeId: string; productId: string },
  storeId: string,
  productId: string,
): void {
  invariant(
    value.storeId === storeId && value.productId === productId,
    'SCOPE_MISMATCH',
    'Inventory facts must belong to the same store and product',
  );
}

export function assertStockRecord(record: StockRecord, storeId: string, productId: string): void {
  assertIdentifier(record.id, 'record.id');
  assertScope(record, storeId, productId);
  assertDate(record.expiresOn);
  assertQuantity(record.quantity, true);
  timestampMicros(record.allocationPriorityAt);
  normalizeLotCode(record.lotCode);
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .filter((key) => object[key] !== undefined)
    .sort(compareText)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(',')}}`;
}
