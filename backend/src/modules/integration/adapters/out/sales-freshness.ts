import type { PrismaTx } from '../../../../shared/infrastructure/prisma.js';
import {
  localClock,
  localInstant,
  hasConfirmedSalesDelay,
  type SalesState,
} from '../../domain/pagonet.js';

export interface SalesFreshness {
  /** Venda mais recente recebida, `AAAA-MM-DD HH:MM` no horário da loja; null se nenhuma. */
  readonly through: string | null;
  /** O mesmo instante em UTC. */
  readonly throughAt: string | null;
  /** Possível atraso significativo, confirmado por leituras recentes sem avanço. */
  readonly delayed: boolean;
}

/**
 * Até quando chegaram as vendas que o próprio servidor busca (Pagonet). Null quando a loja
 * não usa essa origem ou ela está pausada: as outras origens enviam quando querem, e delas
 * só se sabe a hora da última importação.
 */
export async function salesFreshness(
  tx: PrismaTx,
  storeId: string,
  now: Date = new Date(),
): Promise<SalesFreshness | null> {
  const [row] = await tx.$queryRaw<
    {
      sales_through: string | null;
      sales_state: SalesState | null;
      timezone: string;
      sales_catchup: boolean;
      catalog_requested_at: Date | null;
      catalog_attempted_at: Date | null;
      catalog_synced_at: Date | null;
      sales_attempted_at: Date | null;
      sales_synced_at: Date | null;
      last_error: string | null;
    }[]
  >`SELECT s.sales_through, s.sales_state, st.timezone, s.sales_catchup,
           s.catalog_requested_at, s.catalog_attempted_at, s.catalog_synced_at,
           s.sales_attempted_at, s.sales_synced_at, s.last_error
      FROM pagonet_sources s
      JOIN stores st ON st.id = s.store_id
     WHERE s.store_id = ${storeId}::uuid AND s.active`;
  if (!row) return null;
  const clock = localClock(now, row.timezone);
  const [date, time] = row.sales_through?.split(' ') ?? [];
  const at = (value: Date | null) => value?.getTime() ?? Number.NEGATIVE_INFINITY;
  const requested = at(row.catalog_requested_at);
  const pending = requested > at(row.catalog_synced_at) || requested > at(row.sales_synced_at);
  const running =
    at(row.catalog_attempted_at) > at(row.catalog_synced_at) ||
    at(row.sales_attempted_at) > at(row.sales_synced_at);
  return {
    through: row.sales_through,
    throughAt: date && time ? localInstant(date, time, row.timezone) : null,
    delayed:
      !row.sales_catchup &&
      !row.last_error &&
      !pending &&
      !running &&
      hasConfirmedSalesDelay(row.sales_state, row.sales_through, clock.date, clock.minutes, now),
  };
}
