/** Resumo diário de alertas de validade. Funções puras: sem relógio, rede ou banco. */
import { APP_NAME } from '../../../shared/domain/app.js';

/** Seção dos lotes zerados pelas vendas, depois dos níveis da loja. */
export const DEPLETED = 'DEPLETED';

/** Um nível de urgência da loja que avisa, na ordem do mais urgente ao mais tranquilo. */
export interface DigestSection {
  /** O id do nível. */
  readonly key: string;
  readonly title: string;
  /** A faixa do nível é de lotes já vencidos. */
  readonly expired: boolean;
}

export interface DigestAlert {
  readonly productName: string;
  /** Data civil `YYYY-MM-DD`. */
  readonly expiresOn: string;
  readonly quantity: number;
  readonly lotCode: string | null;
  /** O nível do alerta (`DigestSection.key`) ou {@link DEPLETED}. */
  readonly section: string;
}

export interface DigestInput {
  readonly storeName: string;
  /** Data civil da loja no momento do envio, `YYYY-MM-DD`. */
  readonly localDate: string;
  readonly alerts: readonly DigestAlert[];
  /** Os níveis da loja que avisam; um alerta de nível fora da lista não entra. */
  readonly sections: readonly DigestSection[];
  /** Vendas paradas na origem: a mais recente recebida, `AAAA-MM-DD HH:MM`; null se em dia. */
  readonly salesDelayedThrough?: string | null;
}

export interface DigestMessage {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  readonly alertCount: number;
  /** Contagem de cada seção numa linha, para o push: "Vencido: 2, Urgente: 5". */
  readonly summary?: string;
}

const DEPLETED_SECTION = {
  key: DEPLETED,
  title: 'Saldo estimado esgotado',
  summary: 'para conferir',
  hint: 'As vendas zeraram o saldo estimado. Confira na loja se ainda há unidades.',
};

const FOOTER =
  'Saldos estimados pela baixa automática das vendas: sai primeiro o que vence primeiro. ' +
  'Confira fisicamente antes de agir.';

/** Formata `YYYY-MM-DD` como `DD/MM/AAAA` sem conversão de fuso. */
export function formatCivilDate(value: string): string {
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

/** Dias entre duas datas civis; negativo quando `to` é anterior a `from`. */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

function describeDeadline(section: string, days: number): string {
  if (section === DEPLETED) return 'conferir';
  if (days < 0) return days === -1 ? 'venceu ontem' : `venceu há ${-days} dias`;
  if (days === 0) return 'vence hoje';
  return days === 1 ? 'vence amanhã' : `vence em ${days} dias`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Remove quebras de linha que poderiam injetar cabeçalhos no assunto. */
function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim();
}

/**
 * Monta o e-mail do dia, com uma seção por nível da loja que avisa, do mais urgente ao mais
 * tranquilo, e os lotes zerados pelas vendas no fim. Retorna null quando não há nada a avisar.
 */
export function buildAlertDigest(input: DigestInput): DigestMessage | null {
  const known = [
    ...input.sections.map((section) => ({
      ...section,
      summary: section.title,
      hint: section.expired
        ? 'Retire da venda e registre a baixa.'
        : 'Priorize a venda ou a troca.',
    })),
    DEPLETED_SECTION,
  ];
  const sections = known
    .map((section) => ({
      ...section,
      alerts: input.alerts
        .filter((alert) => alert.section === section.key)
        .toSorted(
          (a, b) =>
            a.expiresOn.localeCompare(b.expiresOn) || a.productName.localeCompare(b.productName),
        ),
    }))
    .filter((section) => section.alerts.length > 0);
  if (sections.length === 0) return null;
  const alertCount = sections.reduce((sum, section) => sum + section.alerts.length, 0);

  const summary = sections
    .map((section) =>
      section.key === DEPLETED
        ? `${section.alerts.length} ${section.summary}`
        : `${section.summary}: ${section.alerts.length}`,
    )
    .join(', ');
  const store = singleLine(input.storeName);
  const date = formatCivilDate(input.localDate);
  const subject = `[${APP_NAME}] ${store}: ${summary} (${date})`;

  const line = (alert: DigestAlert) => {
    const deadline = describeDeadline(alert.section, daysBetween(input.localDate, alert.expiresOn));
    const lot = alert.lotCode ? ` · lote ${alert.lotCode}` : '';
    return `${alert.productName} · validade ${formatCivilDate(alert.expiresOn)} (${deadline}) · ${alert.quantity} un.${lot}`;
  };

  // Com as vendas paradas, os saldos não descontam o que saiu depois: o aviso vem antes.
  const through = input.salesDelayedThrough;
  const delay = through
    ? `Atenção: as vendas da loja chegaram só até ${formatCivilDate(through.slice(0, 10))} ${through.slice(11, 16)}. ` +
      'Os saldos abaixo não descontam o que foi vendido depois e podem estar acima do real.'
    : null;

  const text = [
    `Alertas de validade da ${store} em ${date}.`,
    ...(delay ? ['', delay] : []),
    ...sections.flatMap((section) => [
      '',
      `${section.title.toUpperCase()} (${section.alerts.length})`,
      section.hint,
      ...section.alerts.map((alert) => `- ${line(alert)}`),
    ]),
    '',
    FOOTER,
  ].join('\n');

  const cell = 'padding:4px 8px;border-bottom:1px solid #ddd;text-align:left';
  const html = [
    '<!doctype html><html lang="pt-BR"><body style="font-family:Arial,sans-serif;color:#222">',
    `<p>Alertas de validade da <strong>${escapeHtml(store)}</strong> em ${date}.</p>`,
    ...(delay
      ? [`<p style="padding:8px;background:#fff4e5;color:#663c00">${escapeHtml(delay)}</p>`]
      : []),
    ...sections.map((section) =>
      [
        `<h3 style="margin:16px 0 4px">${escapeHtml(section.title)} (${section.alerts.length})</h3>`,
        `<p style="margin:0 0 8px;color:#555">${escapeHtml(section.hint)}</p>`,
        '<table style="border-collapse:collapse"><tr>',
        ...['Produto', 'Validade', 'Prazo', 'Quantidade', 'Lote'].map(
          (h) => `<th style="${cell}">${h}</th>`,
        ),
        '</tr>',
        ...section.alerts.map((alert) =>
          [
            '<tr>',
            `<td style="${cell}">${escapeHtml(alert.productName)}</td>`,
            `<td style="${cell}">${formatCivilDate(alert.expiresOn)}</td>`,
            `<td style="${cell}">${describeDeadline(alert.section, daysBetween(input.localDate, alert.expiresOn))}</td>`,
            `<td style="${cell}">${alert.quantity}</td>`,
            `<td style="${cell}">${escapeHtml(alert.lotCode ?? '—')}</td>`,
            '</tr>',
          ].join(''),
        ),
        '</table>',
      ].join(''),
    ),
    `<p style="margin-top:16px;color:#555;font-size:12px">${FOOTER}</p>`,
    '</body></html>',
  ].join('');

  return { subject, text, html, alertCount, summary };
}

/** Mensagem curta para validar a configuração do canal. */
export function buildTestMessage(storeName: string): DigestMessage {
  const store = singleLine(storeName);
  const text = `Teste de envio dos alertas de validade da ${store}. Se você recebeu esta mensagem, a configuração funciona.`;
  return {
    subject: `[${APP_NAME}] ${store}: teste de envio`,
    text,
    html: `<p>${escapeHtml(text)}</p>`,
    alertCount: 0,
  };
}

/** Normaliza a lista de destinatários: minúsculas, sem espaços e sem repetição. */
export function normalizeRecipients(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))];
}
