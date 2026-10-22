import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { hash, argon2id } from 'argon2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/bootstrap/app.js';
import { Jobs } from '../../src/shared/infrastructure/jobs.js';
import { testCnpj } from '../support/cnpj.js';
import { ean13 } from '../support/ean.js';

type Product = {
  id: string;
  description: string;
  active: boolean;
  photoUrl: string | null;
  barcodes: string[];
};

describe('Catálogo: busca, paginação e leitura por código', () => {
  const storeId = randomUUID(),
    connectionId = randomUUID(),
    cnpj = testCnpj();
  const password = 'TesteCatalogo!2026';
  let admin: Pool, jobs: Jobs, ctx: Awaited<ReturnType<typeof createApp>>, token: string;
  const products: { id: string; description: string; barcodes: string[] }[] = [];

  const get = (path: string) =>
    ctx.app.inject({
      method: 'GET',
      url: `/api/v1${path}`,
      headers: { authorization: `Bearer ${token}` },
    });

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await admin.query("INSERT INTO stores(id,cnpj_normalized,name) VALUES($1,$2,'Loja Catálogo')", [
      storeId,
      cnpj,
    ]);
    await admin.query('INSERT INTO store_settings(store_id) VALUES($1)', [storeId]);
    await admin.query(
      "INSERT INTO store_users(id,store_id,username,username_normalized,password_hash,role,must_change_password) VALUES($1,$2,'catalogo','catalogo',$3,'OPERATOR',false)",
      [
        randomUUID(),
        storeId,
        await hash(password, { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      ],
    );
    await admin.query(
      "INSERT INTO integration_connections(id,store_id,name) VALUES($1,$2,'ERP catálogo')",
      [connectionId, storeId],
    );
    // 51 iogurtes e um queijo: mais de uma página, e busca que precisa ignorar maiúsculas.
    for (let i = 0; i < 52; i++) {
      const description =
        i === 51 ? 'Queijo Minas' : `Iogurte Natural ${String(i).padStart(2, '0')}`;
      const barcodes = [
        ean13(`7890000${String(i).padStart(5, '0')}`),
        ean13(`7891111${String(i).padStart(5, '0')}`),
      ];
      const id = randomUUID();
      products.push({ id, description, barcodes });
      await admin.query(
        'INSERT INTO products(id,store_id,integration_connection_id,external_product_id,description,active) VALUES($1,$2,$3,$4,$5,$6)',
        [id, storeId, connectionId, `ext-${i}`, description, i !== 3],
      );
      // Ordem de inserção invertida: a resposta ordena os códigos, não depende do disco.
      for (const barcode of [...barcodes].reverse())
        await admin.query(
          'INSERT INTO product_barcodes(store_id,product_id,barcode) VALUES($1,$2,$3)',
          [storeId, id, barcode],
        );
    }
    jobs = new Jobs();
    await jobs.start();
    ctx = await createApp({ jobs, jwtSecret: 'test-catalog-api-secret-at-least-thirty-two-bytes' });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mobile/login',
      payload: { cnpj, username: 'catalogo', password },
    });
    expect(login.statusCode, login.body).toBe(200);
    token = login.json().accessToken;
  });

  afterAll(async () => {
    await ctx?.app.close();
    await jobs?.stop();
    if (admin) {
      for (const table of [
        'product_barcodes',
        'product_inventory',
        'products',
        'integration_connections',
        'audit_events',
        'refresh_tokens',
        'push_subscriptions',
        'auth_sessions',
        'store_users',
        'expiry_levels',
        'store_settings',
      ])
        await admin.query(`DELETE FROM ${table} WHERE store_id=$1`, [storeId]);
      await admin.query('DELETE FROM stores WHERE id=$1', [storeId]);
      await admin.end();
    }
    await ctx?.prisma.close();
    await ctx?.database.close();
  });

  it('pagina em ordem alfabética sem pular nem repetir e busca sem diferenciar maiúsculas', async () => {
    const collected: Product[] = [];
    let cursor: string | null = null;
    do {
      const response = await get(`/products?search=IOGURTE${cursor ? `&cursor=${cursor}` : ''}`);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { items: Product[]; nextCursor: string | null };
      expect(body.items.length).toBeLessThanOrEqual(50);
      collected.push(...body.items);
      cursor = body.nextCursor;
    } while (cursor);
    const iogurtes = products.filter((p) => p.description.startsWith('Iogurte'));
    expect(collected.map((p) => p.id)).toEqual(iogurtes.map((p) => p.id));
    const third = collected.find((p) => p.id === products[3]!.id)!;
    expect(third).toEqual({
      id: products[3]!.id,
      description: 'Iogurte Natural 03',
      active: false,
      photoUrl: null,
      barcodes: [...products[3]!.barcodes].sort(),
    });

    const queijo = await get('/products?search=queijo');
    expect(queijo.json()).toEqual({
      items: [expect.objectContaining({ id: products[51]!.id, description: 'Queijo Minas' })],
      nextCursor: null,
    });
    expect((await get('/products?cursor=nao-e-uuid')).json()).toMatchObject({
      code: 'INVALID_REQUEST',
    });
  });

  it('lê o produto pelo ID ou por qualquer um dos seus códigos', async () => {
    const product = products[7]!;
    const byId = await get(`/products/${product.id}`);
    expect(byId.statusCode, byId.body).toBe(200);
    for (const barcode of product.barcodes) {
      const byBarcode = await get(`/products/by-barcode/${barcode}`);
      expect(byBarcode.statusCode, byBarcode.body).toBe(200);
      expect(byBarcode.json()).toEqual(byId.json());
    }
    for (const path of [`/products/${randomUUID()}`, '/products/by-barcode/0000000000000']) {
      const missing = await get(path);
      expect(missing.statusCode, path).toBe(404);
      expect(missing.json()).toMatchObject({ code: 'PRODUCT_NOT_FOUND' });
    }
    // EAN-13 com o último dígito errado nem é procurado.
    const typo = `${product.barcodes[0]!.slice(0, 12)}${(Number(product.barcodes[0]!.slice(12)) + 1) % 10}`;
    const invalid = await get(`/products/by-barcode/${typo}`);
    expect(invalid.statusCode).toBe(422);
    expect(invalid.json()).toMatchObject({ code: 'INVALID_BARCODE' });
  });

  it('acha o código lido com zeros à esquerda ou espaço a mais, sem adivinhar entre dois', async () => {
    const product = products[8]!;
    const [ean] = product.barcodes;
    // O leitor envia o GTIN com 14 dígitos, ou o ERP guardou assim e o leitor manda 13.
    for (const code of [`0${ean}`, ` ${ean}`, `${ean} `]) {
      const found = await get(`/products/by-barcode/${encodeURIComponent(code)}`);
      expect(found.statusCode, JSON.stringify(code)).toBe(200);
      expect(found.json()).toMatchObject({ id: product.id });
    }
    await admin.query(
      'INSERT INTO product_barcodes(store_id,product_id,barcode) VALUES($1,$2,$3)',
      [storeId, product.id, '07891234567895'],
    );
    const padded = await get('/products/by-barcode/7891234567895');
    expect(padded.statusCode).toBe(200);
    expect(padded.json()).toMatchObject({ id: product.id });
    // Dois produtos com o mesmo número em formatos diferentes: ambíguo, não escolhe.
    for (const [index, code] of [
      [8, '041333001005'],
      [9, '0041333001005'],
    ] as const)
      await admin.query(
        'INSERT INTO product_barcodes(store_id,product_id,barcode) VALUES($1,$2,$3)',
        [storeId, products[index]!.id, code],
      );
    expect((await get('/products/by-barcode/00041333001005')).statusCode).toBe(404);
    // Código interno curto não ganha zeros: só GTIN de 8 a 14 dígitos.
    expect((await get('/products/by-barcode/00418')).statusCode).toBe(404);
  });

  it('lista o estoque com os controlados primeiro, em ordem alfabética, e pagina nessa ordem', async () => {
    // Um a cada cinco é controlado; os outros vieram do catálogo e ainda não foram contados.
    for (const [index, product] of products.entries())
      await admin.query(
        'INSERT INTO product_inventory(store_id,product_id,tracking_status) VALUES($1,$2,$3)',
        [storeId, product.id, index % 5 === 0 ? 'TRACKED' : 'UNTRACKED'],
      );
    const collected: { productId: string; productName: string; trackingStatus: string }[] = [];
    let cursor: string | null = null;
    do {
      const response = await get(`/inventory?limit=7${cursor ? `&cursor=${cursor}` : ''}`);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { items: typeof collected; nextCursor: string | null };
      expect(body.items.length).toBeLessThanOrEqual(7);
      collected.push(...body.items);
      cursor = body.nextCursor;
    } while (cursor);
    const byName = (a: { description: string }, b: { description: string }) =>
      a.description < b.description ? -1 : a.description > b.description ? 1 : 0;
    const tracked = products.filter((_, index) => index % 5 === 0).sort(byName);
    const untracked = products.filter((_, index) => index % 5 !== 0).sort(byName);
    expect(collected.map((item) => item.productId)).toEqual(
      [...tracked, ...untracked].map((product) => product.id),
    );
    expect(
      collected.slice(0, tracked.length).every((item) => item.trackingStatus === 'TRACKED'),
    ).toBe(true);
    // A busca também acha pelo código de barras, na mesma ordem.
    const search = await get(`/inventory?search=${products[10]!.barcodes[1]}`);
    expect(search.json()).toMatchObject({ items: [{ productId: products[10]!.id }] });
  });

  it('busca palavras em qualquer ordem, sem acento, com as mais relevantes primeiro', async () => {
    const extras = [
      ['Maçã Gala 1kg', '90001'],
      ['Paçoca Rolha 20g', '90002'],
      ['Coca Cola 2L', '90003'],
      ['Cocada Branca 60g', '90004'],
    ] as const;
    for (const [index, [description, external]] of extras.entries()) {
      const id = randomUUID();
      await admin.query(
        'INSERT INTO products(id,store_id,integration_connection_id,external_product_id,description,active) VALUES($1,$2,$3,$4,$5,true)',
        [id, storeId, connectionId, external, description],
      );
      await admin.query(
        'INSERT INTO product_barcodes(store_id,product_id,barcode) VALUES($1,$2,$3)',
        [storeId, id, ean13(`78922220000${index}`)],
      );
      await admin.query(
        "INSERT INTO product_inventory(store_id,product_id,tracking_status) VALUES($1,$2,'UNTRACKED')",
        [storeId, id],
      );
    }
    const names = async (path: string) =>
      (
        (await get(path)).json() as { items: { description?: string; productName?: string }[] }
      ).items.map((item) => item.description ?? item.productName);
    // Sem acento e sem caixa, com as palavras em qualquer ordem.
    expect(await names('/products?search=gala%20MACA')).toEqual(['Maçã Gala 1kg']);
    expect(await names(`/inventory?search=${encodeURIComponent('maçã')}`)).toEqual([
      'Maçã Gala 1kg',
    ]);
    // Palavra inteira antes de começo de palavra, e esse antes de meio de palavra.
    const coca = ['Coca Cola 2L', 'Cocada Branca 60g', 'Paçoca Rolha 20g'];
    expect(await names('/products?search=coca')).toEqual(coca);
    expect(await names('/inventory?search=coca')).toEqual(coca);
    // Só dígitos: o código do produto no ERP e o código de barras também acham.
    expect(await names('/inventory?search=90003')).toEqual(['Coca Cola 2L']);
    expect(await names(`/products?search=${ean13('789222200003')}`)).toEqual(['Cocada Branca 60g']);
    // % e _ são letras, não curingas.
    expect(await names('/products?search=%25')).toEqual([]);
    expect(await names('/inventory?search=_')).toEqual([]);
  });
});
