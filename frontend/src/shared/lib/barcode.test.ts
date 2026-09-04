import { describe, expect, it } from 'vitest';
import { invalidEan13 } from './barcode';

describe('conferência do EAN-13', () => {
  it('aceita o código cujo último dígito confere', () => {
    for (const code of ['7894900011609', '7891025121923', '7506306241183'])
      expect(invalidEan13(code), code).toBe(false);
  });

  it('recusa o EAN-13 com o último dígito errado', () => {
    expect(invalidEan13('7894900011608')).toBe(true);
  });

  it('não confere outros formatos', () => {
    for (const code of ['78908901', '041333001005', '07891025121923', '0418'])
      expect(invalidEan13(code), code).toBe(false);
  });
});
