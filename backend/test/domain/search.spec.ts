import { describe, expect, it } from 'vitest';
import {
  MAX_SEARCH_WORDS,
  containsPattern,
  invalidEan13,
  searchDigits,
  searchKey,
  searchWords,
} from '../../src/shared/domain/search.js';
import { ean13 } from '../support/ean.js';

describe('busca de produtos', () => {
  it('compara sem acento e sem caixa, como o search_key do banco', () => {
    expect(searchKey('MAÇÃ Gala Pêssego ÁGUA Ñandu')).toBe('maca gala pessego agua nandu');
    expect(searchKey('ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ')).toBe(
      'aaaaaaaaaaaaeeeeeeeeiiiiiiiioooooooooouuuuuuuuccnn',
    );
  });

  it('separa as palavras, sem repetir e com um limite', () => {
    expect(searchWords('  Iogurte   MORANGO iogurte ')).toEqual(['iogurte', 'morango']);
    expect(searchWords('')).toEqual([]);
    expect(searchWords('a b c d e f g h i j')).toHaveLength(MAX_SEARCH_WORDS);
  });

  it('trata % e _ do termo como letras no LIKE', () => {
    expect(containsPattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
  });

  it('reconhece o termo só de dígitos, mesmo com espaços', () => {
    expect(searchDigits('7 894900 011609')).toBe('7894900011609');
    expect(searchDigits('6784')).toBe('6784');
    expect(searchDigits('coca 600')).toBeNull();
  });
});

describe('conferência do EAN-13', () => {
  it('aceita o código cujo último dígito confere', () => {
    for (const code of ['7894900011609', '7891025121923', '7506306241183', '0000000000000'])
      expect(invalidEan13(code), code).toBe(false);
    expect(invalidEan13(ean13('789222200001'))).toBe(false);
  });

  it('recusa o EAN-13 com o último dígito errado', () => {
    expect(invalidEan13('7894900011608')).toBe(true);
    expect(invalidEan13('7891025121920')).toBe(true);
  });

  it('não confere outros formatos: EAN-8, UPC-A, GTIN-14 e códigos internos seguem', () => {
    for (const code of ['78908901', '041333001005', '07891025121923', '0418', '78949000116X'])
      expect(invalidEan13(code), code).toBe(false);
  });
});
