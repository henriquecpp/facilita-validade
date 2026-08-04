import type { InventoryProjection } from './types.js';

export type RecordStatus = 'PENDING' | 'AUTOMATIC' | 'MANUAL' | 'BOTH' | 'EMPTY';

/** Os números de um lote que as telas mostram. */
export interface RecordTotals {
  readonly recordId: string;
  /** Validade atual (a edição no painel pode ter mudado a do lançamento). */
  readonly expiresOn: string;
  /** Quantidade lançada, já com a edição, se houve. */
  readonly launched: number;
  /** Saídas do sistema da loja atribuídas ao lote: vendas e descartes. */
  readonly sold: number;
  /** Baixas manuais, do aplicativo ou do painel. */
  readonly writtenOff: number;
  /** Saldo. */
  readonly quantity: number;
  readonly status: RecordStatus;
}

/**
 * Lançado, vendido, baixa manual, saldo e status de cada lote reconstruído. É daqui que saem os
 * números gravados na projeção e, na conferência, os números esperados: as duas contas são uma.
 */
export function recordTotals(projection: InventoryProjection): RecordTotals[] {
  // Na retomada, `allocations` só tem os fatos refeitos; o que saiu antes vem do retrato.
  const taken = new Map<string, { sold: number; writtenOff: number }>(
    [...(projection.priorOutflows ?? [])].map(([id, entry]) => [id, { ...entry }]),
  );
  for (const allocation of projection.allocations) {
    const entry = taken.get(allocation.stockRecordId) ?? { sold: 0, writtenOff: 0 };
    if (allocation.type === 'MANUAL_WRITE_OFF') entry.writtenOff += allocation.quantity;
    else entry.sold += allocation.quantity;
    taken.set(allocation.stockRecordId, entry);
  }
  return projection.records.map((record) => {
    const { sold, writtenOff } = taken.get(record.id) ?? { sold: 0, writtenOff: 0 };
    const status: RecordStatus =
      record.quantity > 0
        ? 'PENDING'
        : sold && writtenOff
          ? 'BOTH'
          : writtenOff
            ? 'MANUAL'
            : sold
              ? 'AUTOMATIC'
              : 'EMPTY';
    return {
      recordId: record.id,
      expiresOn: record.expiresOn,
      launched: record.launchedQuantity ?? record.quantity,
      sold,
      writtenOff,
      quantity: record.quantity,
      status,
    };
  });
}
