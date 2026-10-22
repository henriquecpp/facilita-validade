import type { PrismaDatabase } from '../../../../shared/infrastructure/prisma.js';
import { ApplicationError } from '../../../../shared/domain/context.js';
import { invalidEan13 } from '../../../../shared/domain/search.js';
import { productSearch } from '../../../../shared/infrastructure/product-search.js';

const PAGE = 50;
const productFields = {
  id: true,
  description: true,
  active: true,
  photo_url: true,
  product_barcodes: { select: { barcode: true }, orderBy: { barcode: 'asc' } },
} as const;
type ProductRow = {
  id: string;
  description: string;
  active: boolean;
  photo_url: string | null;
  product_barcodes: { barcode: string }[];
};
const toProduct = (row: ProductRow) => ({
  id: row.id,
  description: row.description,
  active: row.active,
  photoUrl: row.photo_url,
  barcodes: row.product_barcodes.map((b) => b.barcode),
});

export class PrismaCatalog {
  constructor(readonly prisma: PrismaDatabase) {}
  /**
   * Produtos pelo nome ou pelo código, a mesma busca da lista de Produtos: os mais relevantes
   * primeiro, depois em ordem alfabética.
   */
  list(storeId: string, search = '', cursor?: string) {
    const found = productSearch(storeId, search, 'p');
    const cursorRelevance = productSearch(storeId, search, 'c').rank;
    return this.prisma.tenant(storeId, async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          description: string;
          active: boolean;
          photoUrl: string | null;
          barcodes: string[];
        }[]
      >`
        SELECT p.id, p.description, p.active, p.photo_url AS "photoUrl",
               COALESCE((SELECT array_agg(b.barcode ORDER BY b.barcode) FROM product_barcodes b
                          WHERE b.store_id = p.store_id AND b.product_id = p.id), '{}') AS barcodes
          FROM products p
         WHERE p.store_id = ${storeId}::uuid
           AND (${cursor ?? null}::uuid IS NULL OR (${found.rank}, p.description, p.id) >
                (SELECT ${cursorRelevance}, c.description, c.id FROM products c
                  WHERE c.store_id = ${storeId}::uuid AND c.id = ${cursor ?? null}::uuid))
           ${found.filter}
         ORDER BY ${found.rank}, p.description, p.id
         LIMIT ${PAGE + 1}`;
      return {
        items: rows.slice(0, PAGE),
        nextCursor: rows.length > PAGE ? (rows[PAGE - 1]?.id ?? null) : null,
      };
    });
  }
  async find(storeId: string, value: string, barcode = false) {
    const code = barcode ? value.trim() : value;
    // EAN-13 com o último dígito errado não é um código lido: nem consulta o catálogo, nem pede
    // uma leitura nova dele. Os outros formatos seguem para a consulta.
    if (barcode && invalidEan13(code))
      throw new ApplicationError(
        'INVALID_BARCODE',
        `O código ${code} não é um EAN-13 válido: o último dígito não confere com os anteriores. Confira o número.`,
        422,
      );
    const row = await this.prisma.tenant(storeId, async (tx) => {
      if (!barcode)
        return tx.products.findFirst({
          where: { store_id: storeId, id: code },
          select: productFields,
        });
      const exact = await tx.product_barcodes.findUnique({
        where: { store_id_barcode: { store_id: storeId, barcode: code } },
        select: { products: { select: productFields } },
      });
      if (exact || !/^\d{8,14}$/.test(code)) return exact?.products;
      // O mesmo GTIN com ou sem zeros à esquerda: o ERP cadastra o EAN-13 7891025121923
      // como 07891025121923, e há leitor que envia o UPC-A 041333001005 como
      // 0041333001005. Sem o código exato, vale o mesmo número com outra quantidade de zeros
      // à esquerda, de 8 a 14 dígitos — se só um produto o tiver; na dúvida, nenhum. As formas
      // possíveis são procuradas pelo índice dos códigos, sem varrer o catálogo.
      const core = code.replace(/^0+/, '');
      const forms: string[] = [];
      for (let length = Math.max(8, core.length); length <= 14; length++)
        forms.push(core.padStart(length, '0'));
      const matches = await tx.$queryRaw<{ product_id: string }[]>`
        SELECT DISTINCT product_id FROM product_barcodes
         WHERE store_id = ${storeId}::uuid AND barcode = ANY(${forms}::text[])
         LIMIT 2`;
      if (matches.length !== 1) return null;
      return tx.products.findFirst({
        where: { store_id: storeId, id: matches[0]!.product_id },
        select: productFields,
      });
    });
    if (row) return toProduct(row);
    // Código lido que não está no catálogo: o produto pode ter sido cadastrado no ERP há
    // pouco. Se a loja importa da Pagonet, o worker relê o catálogo na próxima janela —
    // no máximo a cada 10 minutos, para um código que nunca vai existir não custar uma
    // leitura do catálogo inteiro a cada bipe.
    if (barcode)
      await this.prisma.tenant(
        storeId,
        (tx) => tx.$executeRaw`
          UPDATE pagonet_sources SET catalog_requested_at = clock_timestamp()
           WHERE store_id = ${storeId}::uuid AND active
             AND (catalog_requested_at IS NULL OR catalog_requested_at <= catalog_synced_at)
             AND catalog_synced_at < clock_timestamp() - interval '10 minutes'`,
      );
    throw new ApplicationError(
      'PRODUCT_NOT_FOUND',
      'Produto não encontrado. Verifique o código ou a integração.',
      404,
    );
  }
}
