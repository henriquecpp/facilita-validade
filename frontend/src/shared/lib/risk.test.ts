import { describe, expect, it } from 'vitest';
import {
  daysUntil,
  describeRange,
  duplicateLevelLimit,
  expiryText,
  forecastText,
  levelFor,
  levelHierarchy,
  levelOverlap,
  storeToday,
} from './risk';

describe('faixas de validade', () => {
  it('mostra a prévia dos limites com a mesma hierarquia do servidor', () => {
    const levels = levelHierarchy([
      { name: 'Em dia', maxDays: 30 },
      { name: 'Vencido', maxDays: -1 },
      { name: 'Atenção', maxDays: 15 },
      { name: 'Urgente', maxDays: 5 },
    ]);
    expect(levels.map(({ minDays, maxDays }) => [minDays, maxDays])).toEqual([
      [null, -1],
      [0, 5],
      [6, 15],
      [16, 30],
    ]);
    expect([5, 6, 15, 16].map((days) => levelFor(levels, days)?.name)).toEqual([
      'Urgente',
      'Atenção',
      'Atenção',
      'Em dia',
    ]);
    expect(levelFor(levels, 31)).toBeNull();
    expect(levelHierarchy([])).toEqual([]);
  });

  it('sinaliza limites duplicados e permite um único nível aberto cadastrado', () => {
    expect(
      duplicateLevelLimit([
        { name: 'A', maxDays: 5 },
        { name: 'B', maxDays: 5 },
      ]),
    ).toEqual(['A', 'B']);
    expect(duplicateLevelLimit([{ name: 'A' }, { name: 'B', maxDays: null }])).toEqual(['A', 'B']);
    const levels = [
      { name: 'Em dia', maxDays: null },
      { name: 'Alerta', maxDays: 10 },
    ];
    expect(duplicateLevelLimit(levels)).toBeNull();
    expect(levelHierarchy(levels)[1]).toMatchObject({ name: 'Em dia', minDays: 11 });
  });

  it('conta dias entre datas civis, sem depender do horário', () => {
    expect(daysUntil('2026-10-13', '2026-10-13')).toBe(0);
    expect(daysUntil('2026-10-20', '2026-10-13')).toBe(7);
    expect(daysUntil('2026-10-11', '2026-10-13')).toBe(-2);
    // Virada do horário de verão não muda a conta.
    expect(daysUntil('2027-03-01', '2027-02-01')).toBe(28);
  });

  it('segue a regra do servidor: o nível da loja cuja faixa cobre os dias', () => {
    const levels = [
      { name: 'Vencido', minDays: null, maxDays: -1 },
      { name: 'Urgente', minDays: 0, maxDays: 5 },
      { name: 'Atenção', minDays: 6, maxDays: 15 },
    ];
    expect(levelFor(levels, -1)?.name).toBe('Vencido');
    expect(levelFor(levels, 0)?.name).toBe('Urgente');
    expect(levelFor(levels, 5)?.name).toBe('Urgente');
    expect(levelFor(levels, 15)?.name).toBe('Atenção');
    expect(levelFor(levels, 16)).toBeNull();
    expect(levelOverlap(levels)).toBeNull();
    expect(levelOverlap([...levels, { name: 'Crítico', minDays: 4, maxDays: 8 }])).toEqual([
      'Urgente',
      'Crítico',
    ]);
    expect(describeRange(levels[0]!)).toBe('já vencidos');
    expect(describeRange(levels[1]!)).toBe('de 0 a 5 dias');
    expect(describeRange({ minDays: 16, maxDays: null })).toBe('a partir de 16 dias');
  });

  it('escreve o prazo como se fala na loja', () => {
    expect(expiryText(-3)).toBe('Venceu há 3 dias');
    expect(expiryText(-1)).toBe('Venceu ontem');
    expect(expiryText(0)).toBe('Vence hoje');
    expect(expiryText(1)).toBe('Vence amanhã');
    expect(expiryText(9)).toBe('Vence em 9 dias');
  });

  it('usa a data do fuso da loja', () => {
    // 02:30 UTC de 14/10 ainda é 13/10 em São Paulo e já é 14/10 em Lisboa.
    const now = new Date('2026-10-14T02:30:00Z');
    expect(storeToday('America/Sao_Paulo', now)).toBe('2026-10-13');
    expect(storeToday('Europe/Lisbon', now)).toBe('2026-10-14');
    expect(storeToday('Fuso/Inexistente', now)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('previsão de venda do lote', () => {
  it('diz se o lote deve vender antes de vencer ou quanto deve sobrar', () => {
    expect(forecastText(null, 10)).toBeNull();
    expect(forecastText(undefined, 10)).toBeNull();
    expect(forecastText(0, 10)).toEqual({ text: 'Deve vender antes de vencer', ok: true });
    expect(forecastText(1, 10)).toEqual({ text: 'Deve sobrar 1 unidade', ok: false });
    expect(forecastText(4, 10)).toEqual({ text: 'Deve sobrar 4 unidades', ok: false });
    expect(forecastText(10, 10)).toEqual({ text: 'Não deve vender até a validade', ok: false });
  });
});
