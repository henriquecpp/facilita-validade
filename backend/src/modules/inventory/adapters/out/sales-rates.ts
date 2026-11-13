import type { PrismaTx } from '../../../../shared/infrastructure/prisma.js';
import { MIN_HISTORY_DAYS, SALES_WINDOW_MONTHS } from '../../domain/sales-forecast.js';

/** Unidades vendidas de um produto do catálogo (código da origem) num dia. */
export interface DailySale {
  readonly externalProductId: string;
  readonly quantity: number;
}

/**
 * Grava as vendas de um dia encerrado, de todo o catálogo, no lugar das que havia: uma leitura
 * posterior do mesmo dia (fechamento, item cancelado) vale mais que a anterior. Itens de
 * código fora do catálogo ficam de fora. O dia fica registrado mesmo sem nenhum item.
 */
export async function recordDailySales(
  tx: PrismaTx,
  storeId: string,
  connectionId: string,
  day: string,
  sales: readonly DailySale[],
) {
  const totals = new Map<string, number>();
  for (const sale of sales)
    totals.set(sale.externalProductId, (totals.get(sale.externalProductId) ?? 0) + sale.quantity);
  await tx.$executeRaw`
    DELETE FROM product_daily_sales WHERE store_id = ${storeId}::uuid AND day = ${day}::date`;
  if (totals.size)
    await tx.$executeRaw`
      INSERT INTO product_daily_sales(store_id, day, product_id, units)
      SELECT ${storeId}::uuid, ${day}::date, p.id, round(s.units::numeric, 3)
        FROM unnest(${[...totals.keys()]}::text[], ${[...totals.values()]}::float8[]) AS s(external, units)
        JOIN products p
          ON p.store_id = ${storeId}::uuid AND p.integration_connection_id = ${connectionId}::uuid
         AND p.external_product_id = s.external
       WHERE s.units > 0`;
  const units = [...totals.values()].reduce((sum, value) => sum + value, 0);
  await tx.$executeRaw`
    INSERT INTO sales_days(store_id, day, items, units, read_at)
    VALUES (${storeId}::uuid, ${day}::date, ${sales.length}::int, round(${units}::numeric, 3),
            clock_timestamp())
    ON CONFLICT (store_id, day) DO UPDATE
       SET items = excluded.items, units = excluded.units, read_at = excluded.read_at`;
}

/**
 * Média diária de vendas de todos os produtos da loja (ver `domain/sales-forecast.ts`), numa
 * consulta só, gravada em `product_sales_rates`. Roda depois de cada dia encerrado gravado: a
 * média só muda quando entra um dia. Só reescreve a linha que mudou.
 */
export async function refreshSalesRates(tx: PrismaTx, storeId: string) {
  await tx.$executeRaw`
    WITH win AS (
      SELECT (clock_timestamp() AT TIME ZONE timezone)::date AS today,
             ((clock_timestamp() AT TIME ZONE timezone)::date
               - make_interval(months => ${SALES_WINDOW_MONTHS}::int))::date AS first
        FROM stores WHERE id = ${storeId}::uuid
    ), days AS (
      SELECT d.day FROM sales_days d, win
       WHERE d.store_id = ${storeId}::uuid AND d.day >= win.first AND d.day < win.today
         AND d.items > 0
    ), sold AS (
      SELECT s.product_id, sum(s.units) AS units
        FROM product_daily_sales s JOIN days d ON d.day = s.day
       WHERE s.store_id = ${storeId}::uuid
       GROUP BY s.product_id
    ), n AS (SELECT count(*)::int AS days FROM days)
    INSERT INTO product_sales_rates(store_id, product_id, daily_sales, history_days, updated_at)
    SELECT ${storeId}::uuid, i.product_id,
           CASE WHEN n.days >= ${MIN_HISTORY_DAYS}::int
                THEN round(COALESCE(sold.units, 0) / n.days, 4) END,
           n.days, clock_timestamp()
      FROM product_inventory i
     CROSS JOIN n
      LEFT JOIN sold ON sold.product_id = i.product_id
     WHERE i.store_id = ${storeId}::uuid
    ON CONFLICT (store_id, product_id) DO UPDATE
       SET daily_sales = excluded.daily_sales, history_days = excluded.history_days,
           updated_at = excluded.updated_at
     WHERE product_sales_rates.daily_sales IS DISTINCT FROM excluded.daily_sales
        OR product_sales_rates.history_days IS DISTINCT FROM excluded.history_days`;
}
