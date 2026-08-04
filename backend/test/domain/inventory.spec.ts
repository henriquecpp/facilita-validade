import { describe, expect, it } from 'vitest';
import {
  classifyMovementTime,
  confirmCount,
  InventoryDomainError,
  rebuildInventory,
  type ConfirmCountInput,
  type InventoryBaseline,
  type InventoryMovement,
  type RebuildInventoryInput,
  type ReceiptMovement,
  type SaleMovement,
  type ScrapMovement,
  type VoidMovement,
  type StockRecord,
} from '../../src/modules/inventory/domain/index.js';

const storeId = 'store-a';
const productId = 'yogurt';
const at = (time: string): string => `2026-09-26T${time}Z`;
const record = (
  id: string,
  quantity = 50,
  expiresOn = '2026-10-01',
  priority = '14:00:00',
): StockRecord => ({
  id,
  quantity,
  expiresOn,
  allocationPriorityAt: at(priority),
  storeId,
  productId,
  lotCode: id,
});
const baseline = (records: readonly StockRecord[] = [record('A')]): InventoryBaseline => ({
  id: 'epoch-current',
  storeId,
  productId,
  cutoffAt: at('15:30:00'),
  countStartedAt: at('15:00:00'),
  records,
});
const sale = (id = 'sale', quantity = 8, time = '16:00:00'): SaleMovement => ({
  id,
  quantity,
  occurredAt: at(time),
  type: 'SALE',
  storeId,
  productId,
  source: { kind: 'ERP', connectionId: 'erp', externalEventId: id },
});
const receipt = (
  id = 'receipt',
  quantity = 10,
  time = '17:00:00',
  expiresOn: string | undefined = '2026-09-30',
): ReceiptMovement => ({
  id,
  quantity,
  occurredAt: at(time),
  type: 'RETURN_RECEIPT',
  storeId,
  productId,
  stockRecordId: `${id}-record`,
  expiresOn,
  source: { kind: 'ERP', connectionId: 'erp', externalEventId: id },
});
const scrap = (
  id = 'scrap',
  quantity = 5,
  stockRecordId = 'A',
  time = '16:00:00',
): ScrapMovement => ({
  id,
  quantity,
  occurredAt: at(time),
  type: 'SCRAP',
  storeId,
  productId,
  identification: { stockRecordId },
  source: { kind: 'ERP', connectionId: 'erp', externalEventId: id },
});
const voidMovement = (
  originalMovementId: string,
  id = 'void',
  time = '18:00:00',
): VoidMovement => ({
  id,
  originalMovementId,
  occurredAt: at(time),
  type: 'VOID_MOVEMENT',
  storeId,
  productId,
  source: { kind: 'ERP', connectionId: 'erp', externalEventId: id },
});
const input = (
  movements: readonly InventoryMovement[] = [],
  records?: readonly StockRecord[],
): RebuildInventoryInput => ({
  storeId,
  productId,
  trackingStatus: 'TRACKED',
  baseline: baseline(records),
  movements,
  projectionAsOf: at('23:00:00'),
});
const count = (overrides: Partial<ConfirmCountInput> = {}): ConfirmCountInput => ({
  baselineId: 'epoch-next',
  storeId,
  productId,
  countStartedAt: at('19:00:00'),
  cutoffAt: at('19:30:00'),
  lines: [record('count-A', 2), record('count-B', 40)],
  completeProductConfirmed: true,
  emptyProductConfirmed: false,
  ...overrides,
});
function expectError(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(InventoryDomainError);
    expect((error as InventoryDomainError).code).toBe(code);
    return;
  }
  throw new Error(`Expected InventoryDomainError ${code}`);
}

describe('FEFO, temporal eligibility and deterministic replay', () => {
  it('E01 exhausts the earliest expiration before allocating the next record', () => {
    const projection = rebuildInventory(
      input([sale('sale', 25)], [record('A', 20), record('B', 50, '2026-10-02')]),
    );
    expect(projection.records.map(({ id, quantity }) => [id, quantity])).toEqual([
      ['A', 0],
      ['B', 45],
    ]);
    expect(
      projection.allocations.map(({ stockRecordId, quantity }) => [stockRecordId, quantity]),
    ).toEqual([
      ['A', 20],
      ['B', 5],
    ]);
  });

  it('E02 breaks expiration ties by launch timestamp, then by stable ID', () => {
    const projection = rebuildInventory(
      input(
        [sale('sale', 7)],
        [
          record('C', 5, '2026-10-01', '14:00:00'),
          record('B', 5, '2026-10-01', '12:00:00'),
          record('A', 5, '2026-10-01', '12:00:00'),
        ],
      ),
    );
    expect(projection.allocations.map(({ stockRecordId }) => stockRecordId)).toEqual(['A', 'B']);
    expect(projection.totalQuantity).toBe(8);
  });

  it('E03 gives a newly available receipt earlier expiration priority', () => {
    const projection = rebuildInventory(input([receipt(), sale('sale', 5, '18:00:00')]));
    expect(projection.allocations[0]?.stockRecordId).toBe('receipt-record');
    expect(projection.records.find(({ id }) => id === 'A')?.quantity).toBe(50);
  });

  it('E04 covers a late-arriving sale before the count', () => {
    const projection = rebuildInventory(input([sale('old', 8, '14:00:00')]));
    expect(projection.totalQuantity).toBe(50);
    expect(projection.movementResults[0]?.status).toBe('COVERED_BY_COUNT');
  });

  it('E05 consumes a sale occurring after the count', () => {
    expect(rebuildInventory(input([sale()])).totalQuantity).toBe(42);
  });

  it('E06 never allocates an old sale against a physically later receipt', () => {
    const projection = rebuildInventory(input([receipt(), sale()]));
    expect(projection.allocations[0]?.stockRecordId).toBe('A');
    expect(projection.records.find(({ id }) => id === 'receipt-record')?.quantity).toBe(10);
  });

  it('E07 returns identical results for different reception orders and preserves its input', () => {
    const facts = [sale('s1', 4), receipt(), sale('s2', 12, '18:00:00'), voidMovement('s1')];
    const snapshot = JSON.stringify(facts);
    const expected = rebuildInventory(input(facts));
    expect(rebuildInventory(input([...facts].reverse()))).toEqual(expected);
    expect(rebuildInventory(input([facts[2]!, facts[0]!, facts[3]!, facts[1]!]))).toEqual(expected);
    expect(JSON.stringify(facts)).toBe(snapshot);
  });

  it('E08 applies repeated identical facts once and rejects changed payloads', () => {
    expect(rebuildInventory(input([sale(), sale()])).totalQuantity).toBe(42);
    expectError(() => rebuildInventory(input([sale(), sale('sale', 9)])), 'EVENT_PAYLOAD_CONFLICT');
    expectError(
      () => rebuildInventory(input([sale(), { ...sale(), id: 'other-id' }])),
      'EVENT_IDENTITY_CONFLICT',
    );
  });

  it('E10 keeps an excess at its originating sale without consuming a later receipt', () => {
    const projection = rebuildInventory(input([sale('sale', 52), receipt()]));
    expect(projection.totalQuantity).toBe(10);
    expect(projection.issues).toEqual([
      { code: 'UNALLOCATED_QUANTITY', movementId: 'sale', quantity: 2 },
    ]);
    expect(
      projection.movementResults.find(({ movementId }) => movementId === 'sale'),
    ).toMatchObject({ allocatedQuantity: 50, unallocatedQuantity: 2 });
  });

  it('a late fact physically preceding a sale may resolve its previous excess', () => {
    const original = input([sale('sale', 52)]);
    expect(rebuildInventory(original).issues).toHaveLength(1);
    const corrected = rebuildInventory({
      ...original,
      movements: [...original.movements, receipt('receipt', 10, '15:45:00')],
    });
    expect(corrected.totalQuantity).toBe(8);
    expect(corrected.issues).toEqual([]);
  });

  it('E20 keeps quantity when expiration passes without a physical movement', () => {
    const original = input([], [record('expired', 1, '2026-09-20')]);
    expect(rebuildInventory(original).totalQuantity).toBe(1);
    expect(
      rebuildInventory({ ...original, projectionAsOf: '2026-09-27T23:00:00Z' }).totalQuantity,
    ).toBe(1);
  });

  it('E25 retains ERP physical priority across inverted arrival order', () => {
    const facts = [
      receipt('later', 5, '17:00:00'),
      receipt('earlier', 5, '16:00:00'),
      sale('sale', 7, '18:00:00'),
    ];
    const projection = rebuildInventory(input(facts, []));
    expect(
      projection.allocations.map(({ stockRecordId, quantity }) => [stockRecordId, quantity]),
    ).toEqual([
      ['earlier-record', 5],
      ['later-record', 2],
    ]);
    expect(rebuildInventory(input([...facts].reverse(), []))).toEqual(projection);
  });

  it('uses ingress before outgoing movements at the same timestamp', () => {
    const projection = rebuildInventory(
      input([sale('a-sale', 5, '17:00:00'), receipt('z-receipt')], []),
    );
    expect(projection.totalQuantity).toBe(5);
    expect(projection.issues).toEqual([]);
  });

  it('E26 covers an event exactly at cutoff and reports it as count-window quantity', () => {
    const projection = rebuildInventory(input([sale('at-cut', 8, '15:30:00')]));
    expect(projection.totalQuantity).toBe(50);
    expect(projection.countWindowQuantity).toBe(8);
    expect(projection.issues).toEqual([]);
    expect(projection.movementResults[0]?.status).toBe('COVERED_BY_COUNT');
  });

  it('preserves PostgreSQL microseconds around the count cutoff', () => {
    const original = input([
      sale('before', 8, '15:30:00.000001'),
      sale('after', 3, '15:30:00.000003'),
    ]);
    const projection = rebuildInventory({
      ...original,
      baseline: { ...original.baseline!, cutoffAt: at('15:30:00.000002') },
    });
    expect(projection.totalQuantity).toBe(47);
    expect(
      projection.movementResults.find(({ movementId }) => movementId === 'before')?.status,
    ).toBe('COVERED_BY_COUNT');
  });

  it('compares equivalent offsets by physical time', () => {
    const movement = { ...sale(), occurredAt: '2026-09-26T13:00:00-03:00' };
    expect(rebuildInventory(input([movement])).totalQuantity).toBe(42);
  });
});

describe('Documentary voids, physical returns and targeted scrap', () => {
  it('E11 replays later allocations after canceling a post-cutoff sale', () => {
    const projection = rebuildInventory(
      input(
        [sale('first', 20), sale('second', 5, '17:00:00'), voidMovement('first')],
        [record('A', 20), record('B', 50, '2026-10-02')],
      ),
    );
    expect(projection.totalQuantity).toBe(65);
    expect(projection.allocations).toEqual([
      { movementId: 'second', stockRecordId: 'A', quantity: 5, type: 'SALE' },
    ]);
  });

  it('E12 canceling a pre-cutoff sale never adds units to the current snapshot', () => {
    const projection = rebuildInventory(input([sale('old', 8, '14:00:00'), voidMovement('old')]));
    expect(projection.totalQuantity).toBe(50);
    expect(projection.issues).toEqual([]);
  });

  it('E13 leaves an unresolved void pending and resolves it once the original arrives', () => {
    const correction = voidMovement('sale');
    expect(rebuildInventory(input([correction])).issues).toEqual([
      { code: 'PENDING_REFERENCE', movementId: 'void' },
    ]);
    const projection = rebuildInventory(input([correction, sale()]));
    expect(projection.totalQuantity).toBe(50);
    expect(projection.issues).toEqual([]);
  });

  it('E14 keeps a return without expiration pending, then applies its classification at the original time', () => {
    const fact = { ...receipt(), expiresOn: undefined };
    const original = input([fact, sale('sale', 55, '18:00:00')]);
    const pending = rebuildInventory(original);
    expect(pending.issues.map(({ code }) => code)).toContain('PENDING_STOCK_IDENTIFICATION');
    expect(pending.totalQuantity).toBe(0);
    const projection = rebuildInventory({
      ...original,
      resolutions: [
        {
          id: 'classification',
          movementId: fact.id,
          effectiveAt: at('19:00:00'),
          version: 1,
          storeId,
          productId,
          expiresOn: '2026-09-30',
        },
      ],
    });
    expect(projection.totalQuantity).toBe(5);
    expect(projection.issues).toEqual([]);
    expect(projection.allocations[0]?.stockRecordId).toBe('receipt-record');
  });

  it('E15 never uses another record to satisfy targeted scrap excess', () => {
    const projection = rebuildInventory(
      input([scrap('scrap', 25)], [record('A', 20), record('B', 50)]),
    );
    expect(projection.records.find(({ id }) => id === 'B')?.quantity).toBe(50);
    expect(projection.issues).toEqual([
      { code: 'UNALLOCATED_SCRAP', movementId: 'scrap', quantity: 5 },
    ]);
  });

  it('scrap with unknown or not-yet-available record remains pending', () => {
    const projection = rebuildInventory(input([scrap('scrap', 5, 'receipt-record'), receipt()]));
    expect(projection.totalQuantity).toBe(60);
    expect(projection.issues[0]?.code).toBe('PENDING_STOCK_IDENTIFICATION');
  });

  it('targets matching lot and expiration using launch priority', () => {
    const facts = [{ ...scrap(), identification: { lotCode: ' batch ', expiresOn: '2026-10-01' } }];
    const records = [
      { ...record('A', 3, '2026-10-01', '12:00:00'), lotCode: 'batch' },
      { ...record('B', 5), lotCode: 'batch' },
      record('C', 50),
    ];
    const projection = rebuildInventory(input(facts, records));
    expect(
      projection.allocations.map(({ stockRecordId, quantity }) => [stockRecordId, quantity]),
    ).toEqual([
      ['A', 3],
      ['B', 2],
    ]);
  });

  it('requires a date when a lot number identifies multiple expiration dates', () => {
    const records = [
      { ...record('A'), lotCode: 'batch' },
      { ...record('B', 50, '2026-10-02'), lotCode: 'batch' },
    ];
    const fact = { ...scrap(), identification: { lotCode: 'batch' } };
    expect(rebuildInventory(input([fact], records)).issues[0]?.code).toBe(
      'PENDING_STOCK_IDENTIFICATION',
    );
    expect(rebuildInventory(input([fact], [records[0]!])).totalQuantity).toBe(45);
  });

  it('accepts explicit no-lot plus expiration but does not guess an unspecified lot', () => {
    const records = [{ ...record('A'), lotCode: null }];
    const fact = { ...scrap(), identification: { expiresOn: '2026-10-01' } };
    expect(rebuildInventory(input([fact], records)).issues[0]?.code).toBe(
      'PENDING_STOCK_IDENTIFICATION',
    );
    expect(
      rebuildInventory(
        input([{ ...fact, identification: { ...fact.identification, lotCode: null } }], records),
      ).totalQuantity,
    ).toBe(45);
  });

  it('covers pre-cutoff scrap/return without demanding now-irrelevant identification', () => {
    const projection = rebuildInventory(
      input([
        { ...receipt('return', 3, '14:00:00'), expiresOn: undefined },
        { ...scrap('old-scrap', 2, 'unknown', '14:00:00'), identification: undefined },
      ]),
    );
    expect(projection.totalQuantity).toBe(50);
    expect(projection.issues).toEqual([]);
    expect(projection.movementResults.every(({ status }) => status === 'COVERED_BY_COUNT')).toBe(
      true,
    );
  });

  it('rejects voids from another integration, app receipts and void-to-void links', () => {
    const other = {
      ...voidMovement('sale'),
      source: { kind: 'ERP' as const, connectionId: 'other-erp', externalEventId: 'void' },
    };
    expectError(() => rebuildInventory(input([sale(), other])), 'INVALID_VOID_REFERENCE');
    const app = {
      ...receipt(),
      type: 'APP_RECEIPT' as const,
      source: { kind: 'APP' as const, commandId: 'cmd' },
    };
    expectError(
      () => rebuildInventory(input([app, voidMovement('receipt')])),
      'INVALID_VOID_REFERENCE',
    );
    expectError(
      () =>
        rebuildInventory(
          input([sale(), voidMovement('sale'), voidMovement('void', 'second-void')]),
        ),
      'INVALID_VOID_REFERENCE',
    );
    expectError(() => rebuildInventory(input([voidMovement('void')])), 'INVALID_VOID_REFERENCE');
  });

  it('only applies classifications effective by the replay clock', () => {
    const facts = [{ ...receipt(), expiresOn: undefined }];
    const projection = rebuildInventory({
      ...input(facts),
      resolutions: [
        {
          id: 'future-resolution',
          movementId: 'receipt',
          version: 1,
          effectiveAt: '2026-09-27T10:00:00Z',
          storeId,
          productId,
          expiresOn: '2026-10-01',
        },
      ],
    });
    expect(projection.totalQuantity).toBe(50);
    expect(projection.issues[0]?.code).toBe('PENDING_STOCK_IDENTIFICATION');
  });
});

describe('Counting, tracking, future facts and isolation', () => {
  it('E16 covers a late-revealed movement in the count window and quantifies the warning', () => {
    const projection = rebuildInventory(
      input([sale('during-count', 1, '15:15:00'), scrap('scrap-during', 2, 'A', '15:20:00')]),
    );
    expect(projection.countWindowQuantity).toBe(3);
    expect(projection.totalQuantity).toBe(50);
    expect(projection.issues).toEqual([]);
  });

  it('does not count movements before the count start or after the cutoff as window quantity', () => {
    const projection = rebuildInventory(
      input([sale('before-start', 4, '14:59:59'), sale('after-cutoff', 5, '15:30:01')]),
    );
    expect(projection.countWindowQuantity).toBe(0);
    expect(projection.totalQuantity).toBe(45);
  });

  it('E17/E27 replaces the complete snapshot and covers previous physical movements', () => {
    const next = confirmCount(count());
    const projection = rebuildInventory({ ...input([sale('previous', 48)]), baseline: next });
    expect(projection.totalQuantity).toBe(42);
    expect(projection.records.map(({ id, quantity }) => [id, quantity])).toEqual([
      ['count-A', 2],
      ['count-B', 40],
    ]);
    expect(projection.movementResults[0]?.status).toBe('COVERED_BY_COUNT');
  });

  it('E18 produces only the final projection for a replay that reverses prior allocations', () => {
    const original = input([sale('sale', 50)]);
    expect(rebuildInventory(original).totalQuantity).toBe(0);
    const replay = rebuildInventory({
      ...original,
      movements: [sale('sale', 50), voidMovement('sale')],
    });
    expect(replay.totalQuantity).toBe(50);
    expect(replay.allocations).toEqual([]);
    expect(replay.issues).toEqual([]);
    // Notification diffs are committed by the application, never emitted during this replay.
  });

  it('E19 rejects facts, records, baselines and classifications from a different scope', () => {
    expectError(
      () => rebuildInventory(input([{ ...sale(), storeId: 'store-b' }])),
      'SCOPE_MISMATCH',
    );
    expectError(
      () => rebuildInventory(input([], [{ ...record('B'), productId: 'other-product' }])),
      'SCOPE_MISMATCH',
    );
    expectError(
      () => rebuildInventory({ ...input(), baseline: { ...baseline(), storeId: 'store-b' } }),
      'SCOPE_MISMATCH',
    );
    expectError(
      () =>
        rebuildInventory({
          ...input([scrap()]),
          resolutions: [
            {
              id: 'r',
              movementId: 'scrap',
              effectiveAt: at('20:00:00'),
              version: 1,
              storeId: 'store-b',
              productId,
            },
          ],
        }),
      'SCOPE_MISMATCH',
    );
  });

  it('E22 accepts one, rejects zero ingress, and permits an explicitly confirmed zero count', () => {
    expect(rebuildInventory(input([receipt('one', 1)], [])).totalQuantity).toBe(1);
    expectError(() => rebuildInventory(input([receipt('zero', 0)])), 'INVALID_QUANTITY');
    expectError(() => rebuildInventory(input([sale('fraction', 1.5)])), 'INVALID_QUANTITY');
    expect(
      confirmCount(count({ lines: [record('zero', 0)], emptyProductConfirmed: true })).records[0]
        ?.quantity,
    ).toBe(0);
    expectError(
      () => confirmCount(count({ lines: [], emptyProductConfirmed: false })),
      'EMPTY_COUNT_NOT_CONFIRMED',
    );
  });

  it('E28 never invents balances or divergences for an untracked catalog product', () => {
    const projection = rebuildInventory({
      ...input([sale(), { ...receipt(), expiresOn: undefined }]),
      trackingStatus: 'UNTRACKED',
      baseline: null,
    });
    expect(projection.totalQuantity).toBe(0);
    expect(projection.issues).toEqual([]);
    expect(projection.movementResults.every(({ status }) => status === 'NOT_TRACKED')).toBe(true);
  });

  it('E29 holds a future movement until its physical time and applies it once on replay', () => {
    const original = { ...input([sale('future', 8, '16:02:00')]), projectionAsOf: at('16:00:00') };
    expect(rebuildInventory(original).movementResults[0]?.status).toBe('PENDING_FUTURE');
    expect(rebuildInventory(original).totalQuantity).toBe(50);
    const due = { ...original, projectionAsOf: at('16:02:00') };
    expect(rebuildInventory(due).totalQuantity).toBe(42);
    expect(rebuildInventory(due)).toEqual(rebuildInventory(due));
    expect(classifyMovementTime(at('16:02:00'), at('16:00:00'))).toBe('PENDING_FUTURE');
    expect(classifyMovementTime(at('16:00:00'), at('16:00:00'))).toBe('READY');
    expectError(
      () => classifyMovementTime(at('16:05:00.000001'), at('16:00:00')),
      'EVENT_TOO_FAR_IN_FUTURE',
    );
  });

  it('does not activate a future documentary void before its correction timestamp', () => {
    const original = { ...input([sale(), voidMovement('sale')]), projectionAsOf: at('17:00:00') };
    expect(rebuildInventory(original).totalQuantity).toBe(42);
    expect(rebuildInventory({ ...original, projectionAsOf: at('18:00:00') }).totalQuantity).toBe(
      50,
    );
  });

  it('E30 confirms a count with a known movement in its window and reports the quantity', () => {
    const facts = [sale('during', 1, '19:15:00'), sale('after', 2, '19:45:00')];
    const next = confirmCount(count());
    const projection = rebuildInventory({ ...input(facts), baseline: next });
    expect(projection.countWindowQuantity).toBe(1);
    expect(projection.totalQuantity).toBe(40);
  });

  it('E32 ignores a validly voided physical event in the count window', () => {
    const facts = [sale('during', 1, '19:15:00'), voidMovement('during', 'void', '19:20:00')];
    const next = confirmCount(count());
    expect(rebuildInventory({ ...input(facts), baseline: next }).countWindowQuantity).toBe(0);
  });

  it('rejects a count line launched after the cutoff', () => {
    expectError(
      () => confirmCount(count({ lines: [record('late-line', 1, '2026-10-01', '19:31:00')] })),
      'INVALID_RECORD_PRIORITY',
    );
  });

  it('consolidates equivalent lot/date lines without changing the earliest priority', () => {
    const lines = [
      { ...record('late', 3, '2026-10-01', '19:05:00'), lotCode: ' cafe\u0301 ' },
      { ...record('early', 2, '2026-10-01', '19:01:00'), lotCode: 'café' },
    ];
    const next = confirmCount(count({ lines }));
    expect(next.records).toHaveLength(1);
    expect(next.records[0]).toMatchObject({
      id: 'early',
      quantity: 5,
      lotCode: 'café',
      allocationPriorityAt: at('19:01:00'),
    });
    expect(confirmCount(count({ lines: [...lines].reverse() }))).toEqual(next);
  });

  it('requires complete-product confirmation and rejects duplicate count line IDs', () => {
    expectError(() => confirmCount(count({ completeProductConfirmed: false })), 'INCOMPLETE_COUNT');
    const line = record('same', 2);
    expectError(() => confirmCount(count({ lines: [line, line] })), 'DUPLICATE_COUNT_LINE');
  });

  it('rejects impossible dates, timezone-free times and unsafe quantities', () => {
    expectError(() => rebuildInventory(input([], [record('A', 1, '2026-02-30')])), 'INVALID_DATE');
    expectError(
      () => rebuildInventory({ ...input(), projectionAsOf: '2026-09-26T16:00:00' }),
      'INVALID_TIMESTAMP',
    );
    expectError(
      () => rebuildInventory(input([sale('too-large', 1_000_000_001)])),
      'INVALID_QUANTITY',
    );
    expectError(() => rebuildInventory({ ...input(), baseline: null }), 'INVALID_BASELINE');
  });

  it('rejects reused ingress record IDs instead of overwriting quantity', () => {
    const facts = [receipt('first'), { ...receipt('second'), stockRecordId: 'first-record' }];
    expectError(() => rebuildInventory(input(facts)), 'DUPLICATE_RECORD');
    expectError(
      () => rebuildInventory(input([{ ...receipt(), stockRecordId: 'A' }])),
      'DUPLICATE_RECORD',
    );
  });
});

describe('Seeded conservation and ordering properties', () => {
  it('conserves every outgoing quantity across 100 reproducible mixed movement sequences', () => {
    let seed = 20260926;
    const random = (max: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    for (let run = 0; run < 100; run += 1) {
      const starting = random(100);
      const facts: InventoryMovement[] = [];
      let ingressTotal = 0;
      for (let index = 0; index < 20; index += 1) {
        const time = `16:${String(index).padStart(2, '0')}:00`;
        const quantity = 1 + random(20);
        if (random(3) === 0) {
          facts.push(receipt(`in-${index}`, quantity, time));
          ingressTotal += quantity;
        } else {
          facts.push(sale(`out-${index}`, quantity, time));
        }
      }
      const projection = rebuildInventory(input(facts, [record('A', starting)]));
      const allocatedTotal = projection.allocations.reduce(
        (sum, allocation) => sum + allocation.quantity,
        0,
      );
      expect(projection.totalQuantity).toBe(starting + ingressTotal - allocatedTotal);
      for (const result of projection.movementResults) {
        const fact = facts.find(({ id }) => id === result.movementId)!;
        if (fact.type === 'SALE')
          expect(result.allocatedQuantity + result.unallocatedQuantity).toBe(fact.quantity);
      }
      expect(
        projection.records.every(({ quantity }) => Number.isSafeInteger(quantity) && quantity >= 0),
      ).toBe(true);
      const shuffled = [...facts];
      for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const swap = random(index + 1);
        [shuffled[index], shuffled[swap]] = [shuffled[swap]!, shuffled[index]!];
      }
      expect(rebuildInventory(input(shuffled, [record('A', starting)]))).toEqual(projection);
    }
  });
});
