/**
 * Mensagens de push para o proprietário (reunião de 16/10/2026, AV18 e AV25). Funções puras:
 * sem relógio, rede ou banco.
 *
 * Três situações avisam: um lote que entrou num nível de urgência que avisa (inclusive o de
 * vencidos), um lote que as vendas zeraram e o resumo diário. Os alertas que mudam no mesmo
 * minuto vão num push só, para a virada do dia não disparar um push por lote.
 */
import { APP_NAME } from '../../../shared/domain/app.js';
import { formatCivilDate } from './digest.js';

export interface PushMessage {
  readonly title: string;
  readonly body: string;
  /** Tela do painel ou do aplicativo que o toque abre. */
  readonly url: string;
  /** Mensagens com a mesma etiqueta se substituem no aparelho. */
  readonly tag: string;
}

/** Alerta que ainda não foi avisado por push. */
export interface PendingAlert {
  readonly type: 'EXPIRY' | 'DEPLETED';
  readonly productId: string;
  readonly productName: string;
  readonly recordId?: string;
  readonly lotCode?: string | null;
  readonly levelId?: string | null;
  readonly levelLotCount?: number;
  /** Última parcela do lote no evento de venda que o zerou. */
  readonly depletedQuantity?: number | null;
  readonly levelName: string | null;
  readonly quantity: number;
  /** Data civil `YYYY-MM-DD`. */
  readonly expiresOn: string;
  /** Dias até vencer, na data de hoje da loja; negativo é vencido. */
  readonly days: number;
}

function deadline(days: number): string {
  if (days < 0) return days === -1 ? 'venceu ontem' : `venceu há ${-days} dias`;
  if (days === 0) return 'vence hoje';
  return days === 1 ? 'vence amanhã' : `vence em ${days} dias`;
}

/** Um push para os alertas pendentes da loja; null quando não há nenhum. */
export function buildPushAlert(alerts: readonly PendingAlert[]): PushMessage | null {
  if (!alerts.length) return null;
  if (alerts.length === 1) {
    const [alert] = alerts as [PendingAlert];
    const date = formatCivilDate(alert.expiresOn);
    return alert.type === 'DEPLETED'
      ? {
          title: `Lote baixado: ${alert.productName}`,
          body: `Última baixa: ${alert.depletedQuantity ?? alert.quantity} un. do lote ${alert.lotCode ?? date} (validade ${date}). Confira na gôndola se ainda há unidades.`,
          url: `/products/${alert.productId}`,
          tag: `lote-${alert.recordId ?? alert.productId}`,
        }
      : {
          title: `${alert.levelName ?? 'Validade'}: ${alert.productName}`,
          body: `${alert.quantity} un. com validade ${date} (${deadline(alert.days)}).`,
          url: `/products/${alert.productId}`,
          tag: `lote-${alert.productId}`,
        };
  }
  const counts = new Map<string, number>();
  for (const alert of alerts) {
    const key = alert.type === 'DEPLETED' ? 'Lotes baixados' : (alert.levelName ?? 'Validade');
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return {
    title: `${alerts.length} alertas de validade`,
    body: [...counts].map(([name, count]) => `${name}: ${count}`).join(' · '),
    url: '/alerts',
    tag: 'alertas',
  };
}

/** Contagem de lotes do nível, mesmo quando vários pertencem ao mesmo produto. */
export function buildPushLevel(levelId: string, levelName: string, lotCount: number): PushMessage {
  return {
    title: `${levelName}: ${lotCount} ${lotCount === 1 ? 'lote' : 'lotes'}`,
    body: 'Toque para consultar os lotes deste nível.',
    url: `/expiries?nivel=${encodeURIComponent(levelId)}`,
    tag: `nivel-${levelId}`,
  };
}

/** Push do resumo diário, com a contagem de cada seção do e-mail. */
export function buildPushDigest(storeName: string, summary: string): PushMessage {
  return {
    title: `${APP_NAME}: resumo do dia`,
    body: `${storeName.replace(/[\r\n]+/g, ' ').trim()} · ${summary}`,
    url: '/alerts',
    tag: 'resumo-diario',
  };
}
