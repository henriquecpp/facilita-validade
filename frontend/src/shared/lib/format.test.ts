import { describe, expect, it } from 'vitest';
import { formatCnpj, formatDate, formatSince, normalizeCnpj } from './format';
describe('dados digitados no coletor e no painel', () => {
  it('preserva letras do CNPJ e normaliza a máscara', () => {
    expect(normalizeCnpj(' ab.12c.345/01de-90 ')).toBe('AB12C34501DE90');
    expect(formatCnpj('AB12C34501DE90')).toBe('AB.12C.345/01DE-90');
  });
  it('não converte a validade civil para outro dia por causa do fuso horário', () => {
    expect(formatDate('2026-09-26')).toBe('26/09/2026');
  });
  it('diz há quanto tempo, como se fala', () => {
    const now = new Date(2026, 9, 13, 18, 30);
    const at = (hours: number, minutes: number, day = 13) =>
      new Date(2026, 9, day, hours, minutes).toISOString();
    expect(formatSince(at(18, 29), now)).toBe('agora há pouco');
    expect(formatSince(at(18, 18), now)).toBe('há 12 min');
    expect(formatSince(at(15, 10), now)).toBe('há 3 h');
    expect(formatSince(at(9, 5), now)).toBe('hoje às 09:05');
    expect(formatSince(at(22, 40, 12), now)).toBe('ontem às 22:40');
    expect(formatSince(at(8, 0, 10), now)).toBe(formatDate(at(8, 0, 10)));
    expect(formatSince(null, now)).toBe('—');
  });
});
