import type { PrismaDatabase, PrismaTx } from '../../../../shared/infrastructure/prisma.js';
import { instantSql } from '../../../../shared/infrastructure/instants.js';
import { levelFor } from '../../../tenancy/domain/expiry-levels.js';
import type { PrismaStore } from '../../../tenancy/adapters/out/prisma-store.js';
import { rebuildInventory } from '../../domain/index.js';
import { recordTotals, type RecordTotals } from '../../domain/record-totals.js';
import type { PrismaInventory } from './prisma-inventory.js';

/** Um número que a tela mostra diferente da conta refeita. */
export interface AuditDifference {
  /** Onde: o produto e o lote, ou o total da loja. */
  readonly where: string;
  readonly expected: number | string | null;
  readonly shown: number | string | null;
}

export interface AuditReport {
  readonly storeId: string;
  readonly storeName: string;
  /** Produtos com contagem inicial confirmada, conferidos. */
  readonly products: number;
  /** Lotes com saldo que entram nos números da loja. */
  readonly lots: number;
  /**
   * Produtos com venda ou correção recebida e ainda não aplicada: o saldo deles muda na próxima
   * reconstrução, que o worker faz sozinho. Entram nos totais como estão na tela.
   */
  readonly pending: readonly string[];
  readonly differences: readonly AuditDifference[];
}

interface ProductRow {
  id: string;
  description: string;
  price: string | null;
  epoch_id: string;
  input_revision: string;
  applied_input_revision: string;
}

interface StoredLot {
  id: string;
  deleted: boolean;
  expires_on: string;
  quantity: number;
  launched: number;
  sold: number;
  written_off: number;
  status: string;
}

interface CountedLot {
  quantity: number;
  expiresOn: string;
  /** Preço de venda em centavos; null sem preço. */
  cents: number | null;
}

const DAY = 86_400_000;
const cents = (reais: number) => Math.round(reais * 100);
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / DAY);

/**
 * Conferência dos números do estoque, só leitura, num retrato só do banco.
 *
 * 1. Para cada produto controlado, refaz os lotes com o motor de estoque a partir do que foi
 *    gravado (contagem, entradas, vendas, baixas, correções) e compara lançado, vendido, baixa
 *    manual, saldo, validade e status com o que as telas mostram.
 * 2. Confere que nenhum lote de produto sem contagem tem saldo.
 * 3. Soma os lotes conferidos do jeito mais direto (em centavos, sem SQL) e compara com os
 *    números do Início e com o resumo da tela de Validades.
 */
export class InventoryAudit {
  constructor(
    private readonly prisma: PrismaDatabase,
    private readonly inventory: PrismaInventory,
    private readonly store: PrismaStore,
  ) {}

  check(storeId: string): Promise<AuditReport> {
    return this.prisma.tenant(storeId, (tx) => this.run(tx, storeId), { readOnlySnapshot: true });
  }

  private async run(tx: PrismaTx, storeId: string): Promise<AuditReport> {
    const differences: AuditDifference[] = [];
    const differ = (where: string, expected: AuditDifference['expected'], shown: unknown) => {
      if (expected !== shown)
        differences.push({ where, expected, shown: shown as AuditDifference['shown'] });
    };
    const [clock] = await tx.$queryRaw<{ name: string; now: string; today: string }[]>`
      SELECT name, ${instantSql('clock_timestamp()')} AS now,
             to_char((clock_timestamp() AT TIME ZONE timezone)::date, 'YYYY-MM-DD') AS today
        FROM stores WHERE id = ${storeId}::uuid`;
    if (!clock) throw new Error(`Loja ${storeId} não encontrada.`);
    const levels = await tx.$queryRaw<
      { id: string; minDays: number | null; maxDays: number | null; notify: boolean }[]
    >`SELECT id, min_days AS "minDays", max_days AS "maxDays", notify FROM expiry_levels
       WHERE store_id = ${storeId}::uuid ORDER BY min_days NULLS FIRST, id`;

    // Só produto com contagem inicial tem lotes que contam.
    const [untracked] = await tx.$queryRaw<{ lots: number }[]>`
      SELECT count(*)::int AS lots
        FROM stock_records r
        JOIN stock_projections s ON s.store_id = r.store_id AND s.record_id = r.id
        JOIN product_inventory i ON i.store_id = r.store_id AND i.product_id = r.product_id
       WHERE r.store_id = ${storeId}::uuid AND s.quantity > 0
         AND i.tracking_status <> 'TRACKED'`;
    differ('lotes com saldo de produtos sem contagem inicial', 0, untracked?.lots ?? 0);

    const products = await tx.$queryRaw<ProductRow[]>`
      SELECT p.id, p.description, p.sale_price::text AS price, i.epoch_id,
             i.input_revision::text AS input_revision,
             i.applied_input_revision::text AS applied_input_revision
        FROM product_inventory i
        JOIN products p ON p.store_id = i.store_id AND p.id = i.product_id
       WHERE i.store_id = ${storeId}::uuid AND i.tracking_status = 'TRACKED'
       ORDER BY p.description, p.id`;
    const pending: string[] = [];
    const counted: CountedLot[] = [];
    for (const product of products) {
      const price = product.price === null ? null : cents(Number(product.price));
      const stored = await tx.$queryRaw<StoredLot[]>`
        SELECT r.id, r.deleted_at IS NOT NULL AS deleted,
               to_char(s.expires_on, 'YYYY-MM-DD') AS expires_on, s.quantity, s.launched,
               s.sold, s.written_off, s.status
          FROM stock_records r
          JOIN stock_projections s ON s.store_id = r.store_id AND s.record_id = r.id
         WHERE r.store_id = ${storeId}::uuid AND r.product_id = ${product.id}::uuid
           AND r.epoch_id = ${product.epoch_id}::uuid`;
      if (product.input_revision !== product.applied_input_revision) {
        // Ainda vai ser reconstruído: confere os totais com o que está na tela.
        pending.push(product.description);
        for (const lot of stored)
          if (lot.quantity > 0)
            counted.push({ quantity: lot.quantity, expiresOn: lot.expires_on, cents: price });
        continue;
      }
      const { facts, resolutions, baseline } = await this.inventory.inputs(
        tx,
        storeId,
        product.id,
        product.epoch_id,
      );
      const projection = rebuildInventory({
        storeId,
        productId: product.id,
        trackingStatus: 'TRACKED',
        baseline,
        movements: facts,
        resolutions,
        projectionAsOf: clock.now,
      });
      const expected = new Map<string, RecordTotals>(
        recordTotals(projection).map((row) => [row.recordId, row]),
      );
      for (const lot of stored) {
        const where = (field: string) =>
          `${product.description}, lote ${lot.expires_on} (${lot.id}): ${field}`;
        const row = expected.get(lot.id);
        expected.delete(lot.id);
        if (!row) {
          // Fora da reconstrução: excluído, ou entrada anulada.
          differ(where('saldo'), 0, lot.quantity);
          differ(where('status'), lot.deleted ? 'DELETED' : 'EMPTY', lot.status);
          continue;
        }
        differ(where('saldo'), row.quantity, lot.quantity);
        differ(where('lançado'), row.launched, lot.launched);
        differ(where('vendido'), row.sold, lot.sold);
        differ(where('baixa manual'), row.writtenOff, lot.written_off);
        differ(where('validade'), row.expiresOn, lot.expires_on);
        differ(where('status'), row.status, lot.status);
        if (row.quantity > 0)
          counted.push({ quantity: row.quantity, expiresOn: row.expiresOn, cents: price });
      }
      for (const row of expected.values())
        differ(`${product.description}, lote ${row.expiresOn} (${row.recordId})`, 'gravado', null);
      // De que lote saiu cada venda e as pendências: a reconstrução retomada de um retrato grava
      // só o que muda, e tem de chegar ao mesmo que a reconstrução inteira.
      const allocations = await tx.$queryRaw<
        { movement_id: string; record_id: string; quantity: number }[]
      >`SELECT movement_id, record_id, quantity FROM movement_allocations
         WHERE store_id = ${storeId}::uuid AND epoch_id = ${product.epoch_id}::uuid`;
      const wanted = new Set(
        projection.allocations.map((a) => `${a.movementId}|${a.stockRecordId}|${a.quantity}`),
      );
      const shownAllocations = new Set(
        allocations.map((a) => `${a.movement_id}|${a.record_id}|${a.quantity}`),
      );
      differ(
        `${product.description}: baixas por lote diferentes da reconstrução`,
        0,
        [...wanted].filter((key) => !shownAllocations.has(key)).length +
          [...shownAllocations].filter((key) => !wanted.has(key)).length,
      );
      const open = new Set(
        (
          await tx.$queryRaw<{ identity: string }[]>`
            SELECT identity FROM reconciliation_issues
             WHERE store_id = ${storeId}::uuid AND product_id = ${product.id}::uuid
               AND status = 'OPEN'`
        ).map((row) => row.identity),
      );
      const raised = new Set(projection.issues.map((issue) => `${issue.code}:${issue.movementId}`));
      differ(
        `${product.description}: pendências abertas diferentes da reconstrução`,
        0,
        [...raised].filter((key) => !open.has(key)).length +
          [...open].filter((key) => !raised.has(key)).length,
      );
    }

    // Os números do Início e das Validades, somados aqui a partir dos lotes conferidos.
    let expired = 0,
      atRisk = 0,
      unpriced = 0,
      stockValue = 0,
      expiringValue = 0,
      expiredValue = 0;
    type Totals = { lots: number; units: number; value: number };
    const byLevel = new Map<string | null, Totals>();
    const weeks = new Map<number, Totals>();
    const add = <K>(map: Map<K, Totals>, key: K, lot: CountedLot) => {
      const entry = map.get(key) ?? { lots: 0, units: 0, value: 0 };
      entry.lots += 1;
      entry.units += lot.quantity;
      entry.value += lot.quantity * (lot.cents ?? 0);
      map.set(key, entry);
    };
    for (const lot of counted) {
      const left = days(clock.today, lot.expiresOn);
      const level = levelFor(levels, left);
      const value = lot.quantity * (lot.cents ?? 0);
      if (lot.cents === null) unpriced += 1;
      stockValue += value;
      if (left < 0) {
        expired += 1;
        expiredValue += value;
      } else if (level?.notify) {
        atRisk += 1;
        expiringValue += value;
      }
      add(byLevel, level?.id ?? null, lot);
      if (left >= 0) add(weeks, Math.floor(left / 7), lot);
    }
    const shown = await this.store.stockSummary(tx, storeId);
    differ('Início: vencidos sem baixa', expired, shown.expiredRecords);
    differ('Início: a vencer', atRisk, shown.atRiskRecords);
    differ('Início: lotes sem preço', unpriced, shown.unpricedLots);
    differ('Início: valor em estoque (centavos)', stockValue, cents(shown.stockValue));
    differ('Início: valor a vencer (centavos)', expiringValue, cents(shown.expiringValue));
    differ('Início: valor perdido (centavos)', expiredValue, cents(shown.expiredValue));
    const summary = await this.inventory.levelTotals(tx, storeId);
    for (const [label, list] of [
      ['Início', shown.levels],
      ['Validades', summary.items],
    ] as const) {
      const listed = new Set(list.map((item) => item.levelId));
      for (const item of list) {
        const want = byLevel.get(item.levelId) ?? { lots: 0, units: 0, value: 0 };
        const name = `${label}: nível ${item.name}`;
        differ(`${name}, lotes`, want.lots, item.lots);
        differ(`${name}, unidades`, want.units, item.units);
        differ(`${name}, valor (centavos)`, want.value, cents(item.value));
      }
      for (const [levelId, want] of byLevel)
        if (!listed.has(levelId))
          differ(`${label}: nível ${levelId ?? 'sem nível'} ausente, lotes`, want.lots, 0);
    }
    for (const week of shown.upcomingWeeks) {
      const want = weeks.get(week.fromDays / 7) ?? { lots: 0, units: 0, value: 0 };
      const name = `Início: vence em ${week.fromDays} a ${week.toDays} dias`;
      differ(`${name}, lotes`, want.lots, week.lots);
      differ(`${name}, unidades`, want.units, week.units);
      differ(`${name}, valor (centavos)`, want.value, cents(week.value));
    }
    return {
      storeId,
      storeName: clock.name,
      products: products.length,
      lots: counted.length,
      pending,
      differences,
    };
  }
}
