import { describe, expect, it } from 'vitest';
import fixtures from '../../../../contracts/fixtures/expiry-input.json';
import { expiryWarning, maskExpiryInput, parseExpiryInput } from './expiry-date';

describe('digitação da validade (casos compartilhados com o Android)', () => {
  it.each(fixtures.mask)('máscara de %j exibe %j', (typed, shown) => {
    expect(maskExpiryInput(typed as string)).toBe(shown);
  });
  it.each(fixtures.parse)('interpreta %j como %j', (typed, iso) => {
    expect(parseExpiryInput(typed as string)).toBe(iso);
  });
  it.each(fixtures.warning)('avisa sobre %j: %j', (iso, warning) => {
    expect(expiryWarning(iso as string, fixtures.today)).toBe(warning);
  });
  it('digitar tecla a tecla chega ao mesmo resultado que colar', () => {
    let shown = '';
    for (const key of '1.4.2026') shown = maskExpiryInput(shown + key);
    expect(shown).toBe('01/04/2026');
    expect(parseExpiryInput(shown)).toBe('2026-04-01');
  });
});
