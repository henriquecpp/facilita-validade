/**
 * Previsão de venda de cada lote (pedido do piloto, 20/11/2026): se as vendas do produto
 * esvaziam o lote antes da validade, a loja não precisa ser avisada dele.
 *
 * A conta:
 * - média diária = unidades vendidas na janela ÷ dias da janela com venda na loja. A janela é
 *   dos últimos {@link SALES_WINDOW_MONTHS} meses até ontem, com as vendas do dia de todo o
 *   catálogo lidas da Pagonet (`product_daily_sales`), e não só as baixas dos produtos
 *   controlados: a média não depende de quando o produto foi contado. Dia lido sem nenhuma
 *   venda na loja inteira (loja fechada, ou a origem sem dados) não entra na conta;
 * - com menos de {@link MIN_HISTORY_DAYS} dias lidos não há previsão;
 * - as vendas futuras saem dos lotes na mesma ordem da baixa automática (FEFO, inclusive
 *   lotes vencidos ainda com saldo) e na média reduzida por {@link SAFETY_FACTOR};
 * - sobra prevista de um lote = o que ainda restaria dele no fim do dia da validade (os dias
 *   que faltam mais o que resta de hoje, no fuso da loja), arredondada para cima. Zero quer
 *   dizer que deve ser vendido a tempo. A sobra é calculada na leitura (`lot-levels.ts`).
 *
 * Com a opção da loja ligada, lote com sobra prevista zero não alerta, exceto quando vence em
 * até {@link ALWAYS_ALERT_DAYS} dia: perto da validade, saldo no sistema sempre avisa.
 */

/** Meses de vendas usados na média. */
export const SALES_WINDOW_MONTHS = 6;
/** Dias com venda lidos, no mínimo, para haver previsão. */
export const MIN_HISTORY_DAYS = 7;
/** Parte da média considerada na previsão: a margem para semanas mais fracas. */
export const SAFETY_FACTOR = 0.8;
/** Lote que vence em até este número de dias sempre alerta, com ou sem previsão. */
export const ALWAYS_ALERT_DAYS = 1;
