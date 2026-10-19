import { describe, expect, it } from 'vitest';
import {
  InventoryDomainError,
  rebuildInventory,
  type InventoryMovement,
  type RebuildInventoryInput,
  type StockRecord,
} from '../../src/modules/inventory/domain/index.js';
import { recordTotals } from '../../src/modules/inventory/domain/record-totals.js';

/**
 * Correções de registro decididas em 17/10/2026: baixa manual, edição pelo painel e
 * exclusão. Ver `docs/especificacao-estoque.md`, seções 4 e 8 (E33 a E37).
 */
const storeId = 'store-a';
const productId = 'yogurt';
const at = (time: string): string => `2026-09-26T${time}Z`;
const record = (id: string, quantity = 50, expiresOn = '2026-10-01'): StockRecord => ({
  id,
  quantity,
  expiresOn,
  allocationPriorityAt: at('14:00:00'),
  storeId,
  productId,
  lotCode: id,
});
const input = (
  movements: readonly InventoryMovement[] = [],
  records: readonly StockRecord[] = [record('A')],
): RebuildInventoryInput => ({
  storeId,
  productId,
  trackingStatus: 'TRACKED',
  baseline: {
    id: 'epoch-current',
    storeId,
    productId,
    cutoffAt: at('15:30:00'),
    countStartedAt: at('15:00:00'),
    records,
  },
  movements,
  projectionAsOf: at('23:00:00'),
});
const app = (commandId: string) => ({ kind: 'APP' as const, commandId });
const sale = (id: string, quantity: number, time = '16:00:00'): InventoryMovement => ({
  id,
  quantity,
  occurredAt: at(time),
  type: 'SALE',
  storeId,
  productId,
  source: { kind: 'ERP', connectionId: 'erp', externalEventId: id },
});
const receipt = (id: string, quantity: number, time: string): InventoryMovement => ({
  id,
  quantity,
  occurredAt: at(time),
  type: 'APP_RECEIPT',
  storeId,
  productId,
  stockRecordId: `${id}-record`,
  expiresOn: '2026-09-30',
  source: app(id),
});
const writeOff = (
  id: string,
  quantity: number,
  stockRecordId = 'A',
  time = '17:00:00',
): InventoryMovement => ({
  id,
  type: 'MANUAL_WRITE_OFF',
  quantity,
  stockRecordId,
  occurredAt: at(time),
  storeId,
  productId,
  source: app(id),
});
const edit = (
  id: string,
  changes: { expiresOn?: string; quantity?: number },
  stockRecordId = 'A',
  time = '17:00:00',
): InventoryMovement => ({
  id,
  type: 'RECORD_EDIT',
  stockRecordId,
  ...changes,
  occurredAt: at(time),
  storeId,
  productId,
  source: app(id),
});
const remove = (id: string, stockRecordId = 'A', time = '19:00:00'): InventoryMovement => ({
  id,
  type: 'RECORD_DELETE',
  stockRecordId,
  occurredAt: at(time),
  storeId,
  productId,
  source: app(id),
});
const balances = (projection: ReturnType<typeof rebuildInventory>) =>
  Object.fromEntries(projection.records.map(({ id, quantity }) => [id, quantity]));
const statuses = (projection: ReturnType<typeof rebuildInventory>) =>
  Object.fromEntries(
    projection.movementResults.map(({ movementId, status }) => [movementId, status]),
  );
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

describe('Baixa manual', () => {
  it('E33 reduces only its record, and later sales take the rest', () => {
    const facts = [
      sale('s1', 50, '16:00:00'),
      writeOff('w1', 20, 'A', '17:00:00'),
      sale('s2', 30, '18:00:00'),
    ];
    const projection = rebuildInventory(input(facts, [record('A', 100)]));
    expect(balances(projection)).toEqual({ A: 0 });
    expect(projection.records[0]?.launchedQuantity).toBe(100);
    expect(projection.allocations.map(({ type, quantity }) => [type, quantity])).toEqual([
      ['SALE', 50],
      ['MANUAL_WRITE_OFF', 20],
      ['SALE', 30],
    ]);
    expect(projection.issues).toEqual([]);
    expect(rebuildInventory(input([...facts].reverse(), [record('A', 100)]))).toEqual(projection);
  });

  it('E34 never takes the excess from another record; it stays pending', () => {
    const projection = rebuildInventory(
      input([writeOff('w1', 60, 'A')], [record('A', 50), record('B', 50, '2026-10-02')]),
    );
    expect(balances(projection)).toEqual({ A: 0, B: 50 });
    expect(projection.issues).toEqual([
      { code: 'UNALLOCATED_WRITE_OFF', movementId: 'w1', quantity: 10 },
    ]);
  });
});

describe('Exclusão de registro', () => {
  it('E35 moves the sales of the deleted record to the remaining records', () => {
    const records = [record('A', 10), record('B', 10, '2026-10-02')];
    expect(balances(rebuildInventory(input([sale('s1', 4)], records)))).toEqual({ A: 6, B: 10 });
    const after = rebuildInventory(input([sale('s1', 4), remove('d1', 'A')], records));
    expect(balances(after)).toEqual({ B: 6 });
    expect(after.allocations).toEqual([
      { movementId: 's1', stockRecordId: 'B', quantity: 4, type: 'SALE' },
    ]);
    expect(after.totalQuantity).toBe(6);
  });

  it('leaves later sales without a record when every record is deleted', () => {
    const projection = rebuildInventory(
      input([
        receipt('r1', 10, '16:30:00'),
        sale('s1', 12, '17:00:00'),
        remove('d1', 'r1-record'),
        remove('d2', 'A'),
      ]),
    );
    expect(projection.records).toEqual([]);
    expect(projection.issues).toEqual([
      { code: 'UNALLOCATED_QUANTITY', movementId: 's1', quantity: 12 },
    ]);
    expect(statuses(projection)).toMatchObject({
      r1: 'RECORD_DELETED',
      d1: 'APPLIED',
      d2: 'APPLIED',
    });
  });

  it('ignores write-offs and edits of a deleted record', () => {
    const projection = rebuildInventory(
      input(
        [writeOff('w1', 5), edit('e1', { quantity: 80 }, 'A', '18:00:00'), remove('d1')],
        [record('A', 50), record('B', 50, '2026-10-02')],
      ),
    );
    expect(balances(projection)).toEqual({ B: 50 });
    expect(statuses(projection)).toMatchObject({ w1: 'RECORD_DELETED', e1: 'RECORD_DELETED' });
  });
});

describe('Edição pelo painel', () => {
  it('E36 changes the launched quantity from the edit onward and keeps earlier sales', () => {
    const projection = rebuildInventory(
      input([sale('s1', 4, '16:00:00'), edit('e1', { quantity: 20 })], [record('A', 10)]),
    );
    expect(balances(projection)).toEqual({ A: 16 });
    expect(projection.records[0]?.launchedQuantity).toBe(20);
    expect(projection.totalQuantity).toBe(16);
  });

  it('stops at zero and reports the difference when late sales exceed the new quantity', () => {
    const projection = rebuildInventory(
      input([sale('s1', 4, '16:00:00'), edit('e1', { quantity: 3 })], [record('A', 10)]),
    );
    expect(balances(projection)).toEqual({ A: 0 });
    expect(projection.issues).toEqual([
      { code: 'EDIT_BELOW_ALLOCATED', movementId: 'e1', quantity: 1 },
    ]);
  });

  it('E37 a new expiration reorders only the sales after the edit', () => {
    const projection = rebuildInventory(
      input(
        [
          sale('s1', 2, '16:00:00'),
          edit('e1', { expiresOn: '2026-10-10' }, 'A', '17:00:00'),
          sale('s2', 3, '18:00:00'),
        ],
        [record('A', 10, '2026-10-01'), record('B', 10, '2026-10-05')],
      ),
    );
    expect(
      projection.allocations.map(({ movementId, stockRecordId }) => [movementId, stockRecordId]),
    ).toEqual([
      ['s1', 'A'],
      ['s2', 'B'],
    ]);
    expect(projection.records.find(({ id }) => id === 'A')?.expiresOn).toBe('2026-10-10');
    expect(balances(projection)).toEqual({ A: 8, B: 7 });
  });
});

describe('Origem e validação das correções', () => {
  it('accepts corrections only from app commands and validates their content', () => {
    const fromErp = {
      ...writeOff('w1', 5),
      source: { kind: 'ERP' as const, connectionId: 'erp', externalEventId: 'w1' },
    };
    expectError(() => rebuildInventory(input([fromErp])), 'INVALID_MOVEMENT_SOURCE');
    expectError(() => rebuildInventory(input([edit('e1', {})])), 'EMPTY_RECORD_EDIT');
    expectError(() => rebuildInventory(input([writeOff('w1', 0)])), 'INVALID_QUANTITY');
    expectError(
      () => rebuildInventory(input([edit('e1', { expiresOn: '2026-02-30' })])),
      'INVALID_DATE',
    );
  });

  it('keeps corrections before the cutoff out of the snapshot and of the count window', () => {
    const projection = rebuildInventory(
      input([writeOff('w1', 5, 'A', '15:10:00'), edit('e1', { quantity: 1 }, 'A', '15:20:00')]),
    );
    expect(projection.countWindowQuantity).toBe(0);
    expect(projection.totalQuantity).toBe(50);
    expect(projection.movementResults.map(({ status }) => status)).toEqual([
      'COVERED_BY_COUNT',
      'COVERED_BY_COUNT',
    ]);
  });
});

describe('AV31: venda simulada depois do lançamento', () => {
  it('a entrada das 23h40 só recebe a venda das 23h50, não a das 23h35', () => {
    const projection = rebuildInventory({
      ...input(
        [sale('s0', 1, '23:35:00'), receipt('r1', 6, '23:40:00'), sale('s1', 2, '23:50:00')],
        [],
      ),
      projectionAsOf: at('23:59:00'),
    });
    expect(balances(projection)).toEqual({ 'r1-record': 4 });
    expect(projection.allocations).toEqual([
      { movementId: 's1', stockRecordId: 'r1-record', quantity: 2, type: 'SALE' },
    ]);
    expect(projection.issues).toEqual([
      { code: 'UNALLOCATED_QUANTITY', movementId: 's0', quantity: 1 },
    ]);
  });
});

describe('números de cada lote: lançado, vendido, baixa manual, saldo e status', () => {
  it('soma vendas e descartes em vendido, baixas manuais à parte, e o saldo fecha a conta', () => {
    // A = 10 vence antes de B = 10 e C = 0 (linha de contagem zerada).
    const projection = rebuildInventory(
      input(
        [
          sale('s1', 4),
          writeOff('w1', 3, 'A'),
          sale('s2', 5, '18:00:00'),
          writeOff('w2', 10, 'B', '19:00:00'),
        ],
        [
          record('A', 10, '2026-10-01'),
          record('B', 10, '2026-10-05'),
          record('C', 0, '2026-10-09'),
        ],
      ),
    );
    const rows = Object.fromEntries(recordTotals(projection).map((row) => [row.recordId, row]));
    // A: vendeu 4, baixa de 3, vendeu mais 3 e zerou; B: vendeu 2 e a baixa levou o resto.
    expect(rows.A).toMatchObject({
      launched: 10,
      sold: 7,
      writtenOff: 3,
      quantity: 0,
      status: 'BOTH',
    });
    expect(rows.B).toMatchObject({
      launched: 10,
      sold: 2,
      writtenOff: 8,
      quantity: 0,
      status: 'BOTH',
    });
    expect(rows.C).toMatchObject({
      launched: 0,
      sold: 0,
      writtenOff: 0,
      quantity: 0,
      status: 'EMPTY',
    });
    for (const row of Object.values(rows))
      expect(row.launched - row.sold - row.writtenOff).toBe(row.quantity);
  });

  it('distingue o lote zerado pelas vendas do zerado pela baixa e do que ainda tem saldo', () => {
    const projection = rebuildInventory(
      input(
        [sale('s1', 10), writeOff('w1', 10, 'B')],
        [
          record('A', 10, '2026-10-01'),
          record('B', 10, '2026-10-05'),
          record('D', 5, '2026-10-20'),
        ],
      ),
    );
    expect(recordTotals(projection).map((row) => [row.recordId, row.quantity, row.status])).toEqual(
      [
        ['A', 0, 'AUTOMATIC'],
        ['B', 0, 'MANUAL'],
        ['D', 5, 'PENDING'],
      ],
    );
  });
});
