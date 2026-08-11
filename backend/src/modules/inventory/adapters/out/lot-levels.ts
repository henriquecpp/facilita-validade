import { Prisma } from '../../../../generated/prisma/client.js';
import { ALWAYS_ALERT_DAYS, SAFETY_FACTOR } from '../../domain/sales-forecast.js';

/*
 * Nível de urgência de cada lote, calculado na leitura com os níveis atuais da loja
 * (`expiry_levels`): mudar os níveis muda o nível dos lotes na hora. Os trechos esperam os
 * apelidos `r` (stock_records), `s` (stock_projections) e `st` (stores) na consulta.
 */

/** Dias até vencer, na data de hoje da loja: `d.days`. */
export const lotDays = Prisma.raw(`CROSS JOIN LATERAL (
    SELECT (s.expires_on - (clock_timestamp() AT TIME ZONE st.timezone)::date)::int AS days) d`);

/** Nível da loja cuja faixa cobre `d.days`: `lv`, nulo quando nenhuma cobre. */
export const lotLevel = Prisma.raw(`LEFT JOIN LATERAL (
    SELECT l.id, l.name, l.color, l.notify, l.min_days, l.max_days
      FROM expiry_levels l
     WHERE l.store_id = r.store_id
       AND (l.min_days IS NULL OR d.days >= l.min_days)
       AND (l.max_days IS NULL OR d.days <= l.max_days)
     ORDER BY l.min_days NULLS FIRST
     LIMIT 1) lv ON true`);

/** Nome e cor da faixa sem nível, para as listas e os resumos. */
export const NO_LEVEL = { name: 'Sem nível', color: '#9e9e9e' } as const;

/*
 * Sobra prevista do lote na validade (ver `domain/sales-forecast.ts`): as unidades dos lotes
 * que saem antes dele (mesma ordem da baixa automática) mais as dele, menos o que a média
 * reduzida vende do agora até o fim do dia da validade (os dias que faltam mais o que resta de
 * hoje, no fuso da loja), entre zero e o saldo do lote. Sem média (histórico curto) ou com o
 * lote vencido, não há previsão. As constantes entram como literais `numeric`, para a conta não
 * passar por ponto flutuante.
 */
const forecastLeftover = Prisma.raw(`CASE
    WHEN d.days < 0 OR sr.daily_sales IS NULL THEN NULL
    ELSE ceil(least(s.quantity::numeric, greatest(0::numeric,
           s.quantity + COALESCE(sum(s.quantity) OVER (
             PARTITION BY r.product_id ORDER BY s.expires_on, r.allocation_priority_at, r.id
             ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0)
           - sr.daily_sales * ${Number(SAFETY_FACTOR).toFixed(4)}
             * (d.days + 1 - extract(epoch FROM (clock_timestamp() AT TIME ZONE st.timezone)::time) / 86400))))::int
  END`);

/**
 * Lotes que contam nos números da loja: com saldo, da contagem atual de um produto controlado
 * (com contagem inicial confirmada). Lote de contagem anterior, zerado ou excluído fica de fora.
 * O preço segue `numeric`, para os valores em R$ somarem sem erro de arredondamento.
 *
 * Cada lote traz também a média diária do produto, a sobra prevista e `alerting`: se gera
 * alerta. Alerta quem está num nível que avisa, a menos que a loja tenha escolhido não avisar
 * lote previsto para vender a tempo — e mesmo assim os que vencem em até um dia alertam.
 * Com `products`, só os lotes daqueles produtos (a previsão de um lote depende só dos lotes do
 * produto dele).
 */
export const countedLots = (storeId: string, products?: string | readonly string[]) => {
  const only =
    products === undefined ? null : typeof products === 'string' ? [products] : [...products];
  // A loja inteira parte dos lotes com saldo (índice parcial): os zerados se acumulam com os
  // meses, e o planejador, sob a segurança por loja, começava por todos os registros. O
  // `OFFSET 0` mantém a subconsulta separada. Com produtos, os registros deles bastam.
  const lots = only
    ? Prisma.sql`stock_records r
        JOIN stock_projections s ON s.store_id = r.store_id AND s.record_id = r.id`
    : Prisma.sql`(SELECT store_id, record_id, quantity, expires_on FROM stock_projections
                  WHERE store_id = ${storeId}::uuid AND quantity > 0 OFFSET 0) s
        JOIN stock_records r ON r.store_id = s.store_id AND r.id = s.record_id`;
  return Prisma.sql`
  SELECT q.*,
         (q.level_notify IS TRUE
          AND (NOT q.forecast_alerts OR q.days <= ${Prisma.raw(String(ALWAYS_ALERT_DAYS))}
               OR q.forecast_leftover IS NULL OR q.forecast_leftover > 0)) AS alerting
    FROM (
      SELECT r.id, r.product_id, s.expires_on, r.lot_code, s.quantity, d.days,
             lv.id AS level_id, lv.name AS level_name, lv.color AS level_color,
             lv.notify AS level_notify, p.sale_price, sr.daily_sales,
             ${forecastLeftover} AS forecast_leftover,
             COALESCE(ss.sales_forecast_alerts, false) AS forecast_alerts
        FROM ${lots}
        -- A época atual pelo id só: ela já é de um produto (chaves estrangeiras). Com produto e
        -- época juntos, colunas que andam juntas, o planejador estimava um lote só para a loja
        -- inteira e escolhia planos de minutos.
        JOIN product_inventory i
          ON i.store_id = r.store_id AND i.epoch_id = r.epoch_id AND i.tracking_status = 'TRACKED'
        JOIN products p ON p.store_id = r.store_id AND p.id = r.product_id
        JOIN stores st ON st.id = r.store_id
        LEFT JOIN store_settings ss ON ss.store_id = r.store_id
        LEFT JOIN product_sales_rates sr ON sr.store_id = r.store_id AND sr.product_id = r.product_id
        ${lotDays}
        ${lotLevel}
       WHERE r.store_id = ${storeId}::uuid AND s.quantity > 0
         AND (${only}::uuid[] IS NULL OR r.product_id = ANY(${only}::uuid[]))
    ) q`;
};
