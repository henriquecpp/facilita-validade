import { describe, expect, it } from 'vitest';
import {
  normalizeCnpj,
  normalizeUsername,
  validatePassword,
} from '../../src/modules/identity/domain/identity.js';

describe('Identificação da loja', () => {
  it('valida CNPJ numérico e preserva zeros', () => {
    expect(normalizeCnpj('11.222.333/0001-81')).toBe('11222333000181');
    expect(normalizeCnpj('11.444.777/0001-61')).toBe('11444777000161');
    expect(normalizeCnpj('04.252.011/0001-10')).toBe('04252011000110');
  });
  it('valida o exemplo alfanumérico com cálculo ASCII dos dígitos', () =>
    expect(normalizeCnpj('12.abc.345/01de-35')).toBe('12ABC34501DE35'));
  it.each([
    '00000000000000',
    '11222333000180',
    '12ABC34501DE36',
    '12ABC34501DE3A',
    '12#ABC34501DE35',
  ])('rejeita CNPJ inválido %s', (value) => expect(() => normalizeCnpj(value)).toThrow());
  it('normaliza usuário sem colidir entre maiúsculas e minúsculas', () =>
    expect(normalizeUsername('  Admin  ')).toBe('admin'));
  it('impõe senha mínima e limita tamanho', () => {
    expect(() => validatePassword('pequena')).toThrow();
    expect(() => validatePassword('a'.repeat(129))).toThrow();
    expect(() => validatePassword('UmaSenhaNova!2026')).not.toThrow();
  });
});
