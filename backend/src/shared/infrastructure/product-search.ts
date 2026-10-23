import { Prisma } from '../../generated/prisma/client.js';
import { containsPattern, searchDigits, searchWords } from '../domain/search.js';

/** Trechos de SQL da busca de produtos, para uma consulta em que `alias` é o produto. */
export interface ProductSearchSql {
  /** Condição para o `WHERE` (começa com `AND`); vazia sem termo. */
  readonly filter: Prisma.Sql;
  /**
   * Relevância, da melhor para a pior. 0: o código exato, de barras ou do produto no ERP. 1: toda
   * palavra é uma palavra inteira da descrição ("coca" em "COCA COLA"). 2: toda palavra começa
   * uma palavra da descrição ("coca" em "COCADA"). 3: o resto ("coca" em "PACOCA"). Sem termo,
   * 0 para todos.
   */
  readonly rank: Prisma.Sql;
}

/**
 * Busca de produtos. Cada palavra precisa estar na descrição normalizada (`search_text`), em
 * qualquer ordem. Um termo só de dígitos também é procurado nos códigos de barras e no código do
 * produto no ERP.
 *
 * Os candidatos saem de uma subconsulta só. Procurar nos códigos de cada produto, um por um,
 * varria os códigos da loja inteira para cada produto da busca.
 */
export function productSearch(
  storeId: string,
  term: string | undefined,
  alias: string,
): ProductSearchSql {
  const words = searchWords(term ?? '');
  if (!words.length) return { filter: Prisma.empty, rank: Prisma.sql`0` };
  const digits = searchDigits(term ?? '');
  const column = (name: string) => Prisma.raw(`${alias}.${name}`);
  const text = column('search_text');
  const byWords = Prisma.join(
    words.map((word) => Prisma.sql`f.search_text LIKE ${containsPattern(word)}`),
    ' AND ',
  );
  const byCode = digits
    ? Prisma.sql`
        UNION
        SELECT b.product_id FROM product_barcodes b
         WHERE b.store_id = ${storeId}::uuid AND b.barcode LIKE ${containsPattern(digits)}
        UNION
        SELECT f.id FROM products f
         WHERE f.store_id = ${storeId}::uuid AND f.external_product_id = ${digits}`
    : Prisma.empty;
  const filter = Prisma.sql`AND ${column('id')} IN (
      SELECT f.id FROM products f
       WHERE f.store_id = ${storeId}::uuid AND ${byWords}
      ${byCode})`;
  // As palavras da descrição são separadas por espaço.
  const each = (test: (word: string) => Prisma.Sql) =>
    Prisma.join(
      words.map((word) => test(containsPattern(word).slice(1, -1))),
      ' AND ',
    );
  const whole = each(
    (word) => Prisma.sql`(${text} = ${word} OR ${text} LIKE ${`${word} %`}
                          OR ${text} LIKE ${`% ${word} %`} OR ${text} LIKE ${`% ${word}`})`,
  );
  const start = each(
    (word) => Prisma.sql`(${text} LIKE ${`${word}%`} OR ${text} LIKE ${`% ${word}%`})`,
  );
  const exact = digits
    ? Prisma.sql`WHEN ${column('external_product_id')} = ${digits}
                   OR EXISTS (SELECT 1 FROM product_barcodes eb
                               WHERE eb.store_id = ${storeId}::uuid AND eb.barcode = ${digits}
                                 AND eb.product_id = ${column('id')}) THEN 0`
    : Prisma.empty;
  return {
    filter,
    rank: Prisma.sql`(CASE ${exact} WHEN ${whole} THEN 1 WHEN ${start} THEN 2 ELSE 3 END)`,
  };
}
