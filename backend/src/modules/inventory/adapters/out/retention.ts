import type { PrismaTx } from '../../../../shared/infrastructure/prisma.js';
import { SALES_WINDOW_MONTHS } from '../../domain/sales-forecast.js';

/**
 * Limpeza do que é derivado e cresce todo dia, pela limpeza de hora em hora do worker:
 * - vendas por dia além da janela da média (com um mês de folga);
 * - o registro de cada reconstrução (`projection_runs`, um por produto a cada leitura de
 *   vendas), depois de 30 dias, mantendo o último de cada produto.
 * Fatos, lotes, alocações e o histórico de cada produto não saem nunca.
 */
export async function purgeDerivedHistory(tx: PrismaTx, storeId: string) {
  const sales = await tx.$executeRaw`
    DELETE FROM product_daily_sales
     WHERE store_id = ${storeId}::uuid
       AND day < (SELECT ((clock_timestamp() AT TIME ZONE timezone)::date
                          - make_interval(months => ${SALES_WINDOW_MONTHS + 1}::int))::date
                    FROM stores WHERE id = ${storeId}::uuid)`;
  const runs = await tx.$executeRaw`
    DELETE FROM projection_runs r
     USING (SELECT product_id, max(revision) AS last FROM projection_runs
             WHERE store_id = ${storeId}::uuid GROUP BY product_id) l
     WHERE r.store_id = ${storeId}::uuid AND r.product_id = l.product_id
       AND r.revision < l.last AND r.created_at < clock_timestamp() - interval '30 days'`;
  return { sales, runs };
}
