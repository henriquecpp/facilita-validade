import { describe, expect, it } from 'vitest';
import {
  buildAlertDigest,
  daysBetween,
  normalizeRecipients,
  type DigestAlert,
} from '../../src/modules/notifications/domain/digest.js';

const alert = (overrides: Partial<DigestAlert> = {}): DigestAlert => ({
  productName: 'Iogurte natural 170g',
  expiresOn: '2026-10-01',
  quantity: 8,
  lotCode: null,
  section: 'urgente',
  ...overrides,
});
/** Níveis da loja que avisam, do mais urgente ao mais tranquilo. */
const sections = [
  { key: 'vencido', title: 'Vencido', expired: true },
  { key: 'urgente', title: 'Urgente', expired: false },
  { key: 'atencao', title: 'Atenção', expired: false },
];

describe('Resumo diário de alertas', () => {
  it('não gera mensagem quando não há alertas', () => {
    expect(
      buildAlertDigest({ storeName: 'Loja', localDate: '2026-09-28', alerts: [], sections }),
    ).toBeNull();
  });

  it('agrupa pelos níveis da loja, do mais urgente ao mais tranquilo, e os esgotados no fim', () => {
    const message = buildAlertDigest({
      storeName: 'Loja Centro',
      localDate: '2026-09-28',
      sections,
      alerts: [
        alert({ section: 'atencao', expiresOn: '2026-10-10', productName: 'Iogurte morango' }),
        alert({ section: 'DEPLETED', quantity: 0, productName: 'Coalhada' }),
        alert({ section: 'vencido', expiresOn: '2026-09-26', productName: 'Bebida láctea' }),
        alert({ section: 'urgente', expiresOn: '2026-09-28', lotCode: 'L-77' }),
        // Nível que não avisa mais (a loja mudou os níveis): fica de fora.
        alert({ section: 'removido', productName: 'Fora' }),
      ],
    })!;
    expect(message.subject).toBe(
      '[Facilita Validade] Loja Centro: Vencido: 1, Urgente: 1, Atenção: 1, 1 para conferir (28/09/2026)',
    );
    expect(message.summary).toBe('Vencido: 1, Urgente: 1, Atenção: 1, 1 para conferir');
    const titles = ['VENCIDO (1)', 'URGENTE (1)', 'ATENÇÃO (1)', 'SALDO ESTIMADO ESGOTADO'].map(
      (title) => message.text.indexOf(title),
    );
    expect(titles.every((index) => index >= 0)).toBe(true);
    expect([...titles].sort((a, b) => a - b)).toEqual(titles);
    expect(message.text).not.toContain('Fora');
    expect(message.text).toContain('Retire da venda e registre a baixa.');
    expect(message.text).toContain(
      'Bebida láctea · validade 26/09/2026 (venceu há 2 dias) · 8 un.',
    );
    expect(message.text).toContain('validade 28/09/2026 (vence hoje) · 8 un. · lote L-77');
    expect(message.text).toContain('Iogurte morango · validade 10/10/2026 (vence em 12 dias)');
    expect(message.alertCount).toBe(4);
  });

  it('avisa antes da lista quando as vendas pararam de chegar', () => {
    const input = { storeName: 'Loja', localDate: '2026-10-13', alerts: [alert()], sections };
    expect(buildAlertDigest(input)!.text).not.toContain('chegaram só até');
    const message = buildAlertDigest({ ...input, salesDelayedThrough: '2026-10-12 14:09' })!;
    const warning = message.text.indexOf('as vendas da loja chegaram só até 12/10/2026 14:09');
    expect(warning).toBeGreaterThan(0);
    expect(warning).toBeLessThan(message.text.indexOf('URGENTE'));
    expect(message.html).toContain('chegaram só até 12/10/2026 14:09');
  });

  it('escapa HTML vindo do catálogo e remove quebras de linha do assunto', () => {
    const message = buildAlertDigest({
      storeName: 'Loja\r\nBcc: invasor@example.com',
      localDate: '2026-09-28',
      sections,
      alerts: [alert({ productName: '<script>alert(1)</script>', lotCode: '"x"' })],
    })!;
    expect(message.subject).not.toMatch(/[\r\n]/);
    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
    expect(message.html).toContain('&quot;x&quot;');
  });

  it('calcula dias entre datas civis sem depender do fuso', () => {
    expect(daysBetween('2026-10-25', '2026-10-26')).toBe(1);
    expect(daysBetween('2026-02-28', '2026-03-01')).toBe(1);
    expect(daysBetween('2026-09-28', '2026-09-27')).toBe(-1);
  });

  it('normaliza destinatários sem repetir endereços', () => {
    expect(
      normalizeRecipients([' Gerente@Loja.com ', 'gerente@loja.com', '', 'dono@loja.com']),
    ).toEqual(['gerente@loja.com', 'dono@loja.com']);
  });
});
