/**
 * Busca de produtos por texto e conferência do EAN-13. Funções puras.
 *
 * A comparação ignora acento e caixa, como a função `search_key` do banco (migration 0017):
 * "maçã" acha "MACA". As duas usam a mesma tabela de letras, então o termo normalizado aqui
 * casa com a descrição normalizada lá.
 */
const ACCENTED = 'ÁÀÂÃÄÅáàâãäåÉÈÊËéèêëÍÌÎÏíìîïÓÒÔÕÖóòôõöÚÙÛÜúùûüÇçÑñ';
const PLAIN = 'AAAAAAaaaaaaEEEEeeeeIIIIiiiiOOOOOoooooUUUUuuuuCcNn';
const PLAIN_OF = new Map([...ACCENTED].map((char, index) => [char, PLAIN[index]!]));

/** Mais palavras que isso não refinam a busca; só a deixam mais cara. */
export const MAX_SEARCH_WORDS = 8;

/** O texto como a busca o compara: igual a `search_key` no banco. */
export function searchKey(value: string): string {
  return [...value]
    .map((char) => PLAIN_OF.get(char) ?? char)
    .join('')
    .toLowerCase();
}

/**
 * Palavras do termo, normalizadas e sem repetir. Cada uma precisa aparecer na descrição, em
 * qualquer ordem: "iogurte morango" acha "DANONE IOGURTE 1250G MORANGO".
 */
export function searchWords(term: string): string[] {
  return [...new Set(searchKey(term).split(/\s+/).filter(Boolean))].slice(0, MAX_SEARCH_WORDS);
}

/** Padrão de LIKE que acha o texto em qualquer posição, com `%`, `_` e `\` escapados. */
export function containsPattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

/** Só dígitos, desconsiderando espaços: o termo também é procurado nos códigos. */
export function searchDigits(term: string): string | null {
  const digits = term.replace(/\s+/g, '');
  return /^\d+$/.test(digits) ? digits : null;
}

/**
 * EAN-13 que não confere: 13 dígitos cujo último não é o verificador dos 12 primeiros (pesos 1
 * e 3 alternados, GS1). Só o EAN-13 é conferido; os outros formatos seguem para a consulta.
 */
export function invalidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  const sum = [...code.slice(0, 12)].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return (10 - (sum % 10)) % 10 !== Number(code[12]);
}
