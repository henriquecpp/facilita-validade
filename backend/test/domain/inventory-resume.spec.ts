import { describe, expect, it } from 'vitest';
import {
  rebuildInventory,
  resumeInventory,
  timestampMicros,
  type InventoryMovement,
  type InventoryProjection,
  type RebuildInventoryInput,
  type ReplayCheckpoint,
  type StockRecord,
} from '../../src/modules/inventory/domain/index.js';
import { recordTotals } from '../../src/modules/inventory/domain/record-totals.js';

/**
 * A retomada a partir de um retrato tem de dar exatamente a reconstrução completa: saldos,
 * lançado/vendido/baixa manual de cada lote, pendências e alocações. Cenários aleatórios (com
 * semente fixa) misturam vendas no mesmo minuto, entradas, baixas, edições, exclusões,
 * descartes, cancelamentos, fatos futuros e fatos atrasados, e simulam o que o adaptador carrega
 * do banco: os fatos de instante igual ou posterior ao da posição, os gravados depois do retrato
 * e os originais dos cancelamentos.
 */
const storeId = 'store';
const productId = 'product';
const day = '2026-09-26';
const at = (minutes: number) =>
  `${day}T${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}:00Z`;
const minutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Gerador determinístico (mulberry32). */
function random(seed: number) {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (min: number, max: number) => min + Math.floor(next() * (max - min + 1));
  const pick = <T>(items: readonly T[]) => items[Math.floor(next() * items.length)]!;
  return { next, int, pick };
}

interface Scenario {
  baseline: StockRecord[];
  first: InventoryMovement[];
  second: InventoryMovement[];
  snapshotAt: string;
}

function scenario(seed: number): Scenario {
  const r = random(seed);
  let n = 0;
  const id = (prefix: string) => `${prefix}${++n}`;
  const expiry = () => `2026-10-${String(r.int(1, 28)).padStart(2, '0')}`;
  const baseline: StockRecord[] = Array.from({ length: r.int(1, 3) }, () => ({
    id: id('C'),
    storeId,
    productId,
    expiresOn: expiry(),
    lotCode: r.next() < 0.3 ? null : `L${n}`,
    quantity: r.int(0, 40),
    allocationPriorityAt: at(minutes('07:50') - r.int(0, 10)),
  }));
  const recordIds = baseline.map((record) => record.id);
  const sales: { id: string; time: number }[] = [];
  const erp = (prefix: string) => {
    const movementId = id(prefix);
    return {
      id: movementId,
      storeId,
      productId,
      source: { kind: 'ERP' as const, connectionId: 'erp', externalEventId: movementId },
    };
  };
  const app = (prefix: string) => {
    const movementId = id(prefix);
    return {
      id: movementId,
      storeId,
      productId,
      source: { kind: 'APP' as const, commandId: `cmd-${movementId}` },
    };
  };
  const fact = (from: number, to: number, allowCorrections: boolean): InventoryMovement => {
    // Minutos inteiros: vendas no mesmo instante desempatam pela chave.
    const time = r.int(from, to);
    const kind = r.next();
    if (kind < 0.55 || !allowCorrections) {
      const sale = {
        ...erp('S'),
        type: 'SALE' as const,
        quantity: r.int(1, 6),
        occurredAt: at(time),
      };
      sales.push({ id: sale.id, time });
      return sale;
    }
    if (kind < 0.67) {
      const receipt = {
        ...app('R'),
        type: 'APP_RECEIPT' as const,
        quantity: r.int(1, 30),
        expiresOn: expiry(),
        lotCode: r.next() < 0.5 ? `RL${n}` : undefined,
        stockRecordId: `rec-${n}`,
        occurredAt: at(time),
      };
      recordIds.push(receipt.stockRecordId);
      return receipt;
    }
    if (kind < 0.74)
      return {
        ...app('W'),
        type: 'MANUAL_WRITE_OFF',
        quantity: r.int(1, 8),
        stockRecordId: r.pick(recordIds),
        occurredAt: at(time),
      };
    if (kind < 0.8)
      return {
        ...app('E'),
        type: 'RECORD_EDIT',
        stockRecordId: r.pick(recordIds),
        ...(r.next() < 0.5 ? { expiresOn: expiry() } : { quantity: r.int(0, 40) }),
        occurredAt: at(time),
      };
    if (kind < 0.83)
      return {
        ...app('D'),
        type: 'RECORD_DELETE',
        stockRecordId: r.pick(recordIds),
        occurredAt: at(time),
      };
    if (kind < 0.88)
      return {
        ...erp('X'),
        type: 'SCRAP',
        quantity: r.int(1, 5),
        identification: { stockRecordId: r.pick(recordIds) },
        occurredAt: at(time),
      };
    // Cancelamento de uma venda anterior (às vezes de uma que ainda não chegou).
    const target = sales.length && r.next() < 0.9 ? r.pick(sales) : { id: 'S-missing', time };
    return {
      ...erp('V'),
      type: 'VOID_MOVEMENT',
      originalMovementId: target.id,
      occurredAt: at(Math.max(time, target.time)),
    };
  };
  const first: InventoryMovement[] = [];
  // Antes da contagem e na janela dela (cobertos pela contagem).
  for (let i = r.int(0, 3); i > 0; i--) first.push(fact(minutes('07:00'), minutes('07:59'), false));
  // Depois do corte; alguns além do instante da primeira reconstrução (futuros nela).
  for (let i = r.int(5, 40); i > 0; i--) first.push(fact(minutes('08:01'), minutes('14:30'), true));
  const snapshotAt = at(r.int(minutes('08:30'), minutes('13:30')));
  const second: InventoryMovement[] = [];
  for (let i = r.int(0, 25); i > 0; i--) {
    const late = r.next() < 0.08;
    second.push(
      late
        ? fact(minutes('08:01'), minutes('13:00'), true)
        : fact(minutes('13:00'), minutes('20:00'), true),
    );
  }
  return { baseline, first, second, snapshotAt };
}

const input = (
  baseline: StockRecord[],
  movements: readonly InventoryMovement[],
  asOf: string,
  snapshotAt?: string,
): RebuildInventoryInput => ({
  storeId,
  productId,
  trackingStatus: 'TRACKED',
  baseline: {
    id: 'epoch',
    storeId,
    productId,
    cutoffAt: at(minutes('08:00')),
    countStartedAt: at(minutes('07:30')),
    records: baseline,
  },
  movements,
  projectionAsOf: asOf,
  snapshotAt,
});

/** O que o adaptador carrega para retomar: como em `PrismaInventory.rebuild`. */
function resumeLike(
  s: Scenario,
  checkpoint: ReplayCheckpoint,
  asOf: string,
  snapshotAt: string,
): InventoryProjection | 'late' | null {
  const all = [...s.first, ...s.second];
  const boundary = timestampMicros(checkpoint.position.occurredAt);
  const fresh = new Set(s.second.map((movement) => movement.id));
  if (s.second.some((movement) => timestampMicros(movement.occurredAt) < boundary)) return 'late';
  const loaded = all.filter((movement) => timestampMicros(movement.occurredAt) >= boundary);
  const loadedIds = new Set(loaded.map((movement) => movement.id));
  const wanted = new Set([
    ...loaded.flatMap((movement) =>
      movement.type === 'VOID_MOVEMENT' ? [movement.originalMovementId] : [],
    ),
    ...checkpoint.pendingVoids.map((entry) => entry.originalId),
  ]);
  const references = all.filter(
    (movement) => wanted.has(movement.id) && !loadedIds.has(movement.id),
  );
  // O retrato passa por JSON, como no banco.
  const stored = JSON.parse(JSON.stringify(checkpoint)) as ReplayCheckpoint;
  return resumeInventory(input(s.baseline, loaded, asOf, snapshotAt), {
    checkpoint: stored,
    fresh,
    references,
  });
}

const sortAllocations = (projection: InventoryProjection, only?: Set<string>) =>
  projection.allocations
    .filter((allocation) => !only || only.has(allocation.movementId))
    .map((a) => `${a.movementId}>${a.stockRecordId}:${a.quantity}:${a.type}`)
    .sort();
const normalize = (checkpoint: ReplayCheckpoint | undefined) =>
  checkpoint && {
    ...checkpoint,
    issues: checkpoint.issues.map((issue) => JSON.stringify(issue)).sort(),
    deleted: [...checkpoint.deleted].sort(),
    voided: [...checkpoint.voided].sort(),
    pendingVoids: checkpoint.pendingVoids.map((entry) => entry.voidId).sort(),
    ingressIds: [...checkpoint.ingressIds].sort(),
  };

describe('Retomada da reconstrução a partir de um retrato', () => {
  it('dá o mesmo resultado da reconstrução completa em 1.500 cenários aleatórios', () => {
    const asOf1 = at(minutes('14:00'));
    const asOf2 = at(minutes('21:00'));
    const outcome = { resumed: 0, fallback: 0, late: 0, noCheckpoint: 0 };
    for (let seed = 1; seed <= 1500; seed++) {
      const s = scenario(seed);
      const firstRun = rebuildInventory(input(s.baseline, s.first, asOf1, s.snapshotAt));
      const checkpoint = firstRun.checkpoint;
      const all = [...s.first, ...s.second];
      const nextSnapshot = at(minutes('18:00'));
      const expected = rebuildInventory(input(s.baseline, all, asOf2, nextSnapshot));
      if (!checkpoint) {
        outcome.noCheckpoint++;
        continue;
      }
      const resumed = resumeLike(s, checkpoint, asOf2, nextSnapshot);
      if (resumed === 'late') {
        outcome.late++;
        continue;
      }
      if (resumed === null) {
        outcome.fallback++;
        continue;
      }
      outcome.resumed++;
      const context = `semente ${seed}`;
      expect(resumed.records, context).toEqual(expected.records);
      expect(resumed.totalQuantity, context).toBe(expected.totalQuantity);
      expect(resumed.issues, context).toEqual(expected.issues);
      expect(resumed.countWindowQuantity, context).toBe(expected.countWindowQuantity);
      expect(recordTotals(resumed), context).toEqual(recordTotals(expected));
      // As alocações refeitas são as da reconstrução completa para esses fatos...
      const replayed = new Set(resumed.replayed);
      expect(sortAllocations(resumed), context).toEqual(sortAllocations(expected, replayed));
      // ...e as dos outros fatos não mudam: as gravadas na primeira reconstrução continuam certas.
      const kept = new Set(all.map((movement) => movement.id).filter((id) => !replayed.has(id)));
      expect(sortAllocations(firstRun, kept), context).toEqual(sortAllocations(expected, kept));
      // O retrato novo (ou o mesmo, sem fato novo até o instante dele) é o que a reconstrução
      // completa tiraria.
      expect(normalize(resumed.checkpoint ?? checkpoint), context).toEqual(
        normalize(expected.checkpoint),
      );
    }
    // Os cenários exercitam os três caminhos.
    expect(outcome.resumed).toBeGreaterThan(400);
    expect(outcome.fallback).toBeGreaterThan(20);
    expect(outcome.late).toBeGreaterThan(20);
  });

  it('volta para a reconstrução completa quando um fato anterior à posição muda', () => {
    const baseline: StockRecord[] = [
      {
        id: 'A',
        storeId,
        productId,
        expiresOn: '2026-10-01',
        quantity: 20,
        allocationPriorityAt: at(minutes('07:50')),
      },
    ];
    const sale = (id: string, time: string): InventoryMovement => ({
      id,
      storeId,
      productId,
      type: 'SALE',
      quantity: 1,
      occurredAt: at(minutes(time)),
      source: { kind: 'ERP', connectionId: 'erp', externalEventId: id },
    });
    const first = [sale('s1', '09:00'), sale('s2', '10:00'), sale('s3', '12:00')];
    const { checkpoint } = rebuildInventory(
      input(baseline, first, at(minutes('13:00')), at(minutes('11:00'))),
    );
    expect(checkpoint?.position.key).toContain('s2');
    const resume = (
      movements: InventoryMovement[],
      fresh: string[],
      references: InventoryMovement[] = [],
    ) =>
      resumeInventory(input(baseline, movements, at(minutes('20:00'))), {
        checkpoint: checkpoint!,
        fresh: new Set(fresh),
        references,
      });
    // Venda nova depois da posição: retoma.
    expect(
      resume([sale('s2', '10:00'), sale('s3', '12:00'), sale('s4', '15:00')], ['s4']),
    ).not.toBeNull();
    // Venda nova no mesmo minuto da posição, mas antes dela na ordem: atrasada.
    expect(
      resume([sale('s0', '10:00'), sale('s2', '10:00'), sale('s3', '12:00')], ['s0']),
    ).toBeNull();
    // Cancelamento de uma venda anterior à posição.
    const voidS1: InventoryMovement = {
      id: 'v1',
      storeId,
      productId,
      type: 'VOID_MOVEMENT',
      originalMovementId: 's1',
      occurredAt: at(minutes('15:00')),
      source: { kind: 'ERP', connectionId: 'erp', externalEventId: 'v1' },
    };
    expect(
      resume([sale('s2', '10:00'), sale('s3', '12:00'), voidS1], ['v1'], [sale('s1', '09:00')]),
    ).toBeNull();
    // Exclusão do registro.
    const remove: InventoryMovement = {
      id: 'd1',
      storeId,
      productId,
      type: 'RECORD_DELETE',
      stockRecordId: 'A',
      occurredAt: at(minutes('15:00')),
      source: { kind: 'APP', commandId: 'd1' },
    };
    expect(resume([sale('s2', '10:00'), sale('s3', '12:00'), remove], ['d1'])).toBeNull();
  });
});
