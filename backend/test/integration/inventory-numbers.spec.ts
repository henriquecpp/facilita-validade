import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { hash, argon2id } from 'argon2';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/bootstrap/app.js';
import { Jobs } from '../../src/shared/infrastructure/jobs.js';
import { stableId } from '../../src/modules/integration/adapters/out/prisma-integration.js';
import { InventoryAudit } from '../../src/modules/inventory/adapters/out/inventory-audit.js';
import { PrismaStore } from '../../src/modules/tenancy/adapters/out/prisma-store.js';
import { testCnpj } from '../support/cnpj.js';

/**
 * Os números do estoque, conferidos um a um num cenário com tudo o que muda a conta: lote
 * vencido, a vencer e em dia, venda que zera lote, baixa manual, lote excluído, recontagem,
 * produto sem preço, produto inativo e produtos sem contagem inicial — inclusive um com a
 * contagem aberta. Só os lotes com saldo da contagem atual de produtos controlados contam.
 */
describe('Números do estoque', () => {
  const storeId = randomUUID(),
    ownerId = randomUUID(),
    cnpj = testCnpj();
  const password = 'TesteNumeros!2026';
  let admin: Pool, jobs: Jobs, ctx: Awaited<ReturnType<typeof createApp>>;
  let owner: string, apiKey: string, connectionId: string, audit: InventoryAudit;
  const id = (external: string) => stableId(storeId, connectionId, external, 'product');

  interface Lot {
    id: string;
    expiresOn: string;
    quantity: number;
    version: number;
  }

  function call(
    path: string,
    method: InjectOptions['method'] = 'GET',
    body?: unknown,
    token = owner,
  ) {
    return ctx.app.inject({
      method,
      url: `/api/v1${path}`,
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      payload: body ? JSON.stringify(body) : undefined,
    });
  }
  async function ok<T>(
    path: string,
    method: InjectOptions['method'] = 'GET',
    body?: unknown,
    token = owner,
  ) {
    const response = await call(path, method, body, token);
    expect(response.statusCode, `${method} ${path}: ${response.body}`).toBeLessThan(300);
    return response.json() as T;
  }
  /** Data civil a `days` dias de hoje, no fuso da loja. */
  async function day(days: number) {
    const { rows } = await admin.query<{ day: string }>(
      `SELECT to_char((clock_timestamp() AT TIME ZONE timezone)::date + $2::int, 'YYYY-MM-DD') AS day
         FROM stores WHERE id = $1`,
      [storeId, days],
    );
    return rows[0]!.day;
  }
  /** Contagem do produto com as linhas `[dias até vencer, quantidade]`; confirma se pedido. */
  async function count(external: string, lines: [number, number][], confirm = true) {
    let session = await ok<{ id: string; version: number }>('/count-sessions', 'POST', {
      productId: id(external),
    });
    const body = [];
    for (const [days, quantity] of lines)
      body.push({ id: randomUUID(), expiresOn: await day(days), quantity });
    session = await ok(`/count-sessions/${session.id}/lines`, 'PUT', {
      expectedVersion: session.version,
      lines: body,
    });
    if (confirm)
      await ok(`/count-sessions/${session.id}/confirm`, 'POST', {
        expectedVersion: session.version,
        completeConfirmed: true,
      });
  }
  const lots = async (external: string) =>
    (await ok<{ records: Lot[] }>(`/inventory/products/${id(external)}`)).records;

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await admin.query("INSERT INTO stores(id,cnpj_normalized,name) VALUES($1,$2,'Loja Números')", [
      storeId,
      cnpj,
    ]);
    await admin.query('INSERT INTO store_settings(store_id) VALUES($1)', [storeId]);
    await admin.query(
      "INSERT INTO store_users(id,store_id,username,username_normalized,password_hash,role,must_change_password) VALUES($1,$2,'dono','dono',$3,'OWNER',false)",
      [
        ownerId,
        storeId,
        await hash(password, { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      ],
    );
    jobs = new Jobs();
    await jobs.start();
    ctx = await createApp({
      jobs,
      jwtSecret: 'test-inventory-numbers-secret-at-least-32-bytes',
      notificationChannels: [],
    });
    audit = new InventoryAudit(ctx.prisma, ctx.inventory, new PrismaStore(ctx.prisma, jobs));
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mobile/login',
      payload: { cnpj, username: 'dono', password },
    });
    expect(login.statusCode, login.body).toBe(200);
    owner = login.json().accessToken;
    connectionId = (await ok<{ id: string }>('/integration-connections', 'POST', { name: 'ERP' }))
      .id;
    apiKey = (
      await ok<{ key: string }>('/integration-keys', 'POST', {
        connectionId,
        scopes: ['catalog:write', 'movements:write'],
      })
    ).key;
    const catalog = await ok<{ id: string }>(
      '/integrations/catalog-batches',
      'POST',
      {
        externalBatchId: randomUUID(),
        products: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((external) => ({
          externalProductId: external,
          description: `Produto ${external.toUpperCase()}`,
          barcodes: [],
        })),
      },
      apiKey,
    );
    await ctx.integration.process(storeId, catalog.id);
    // Preço de venda, em reais; C fica sem preço.
    for (const [external, price] of [
      ['a', 10],
      ['b', 2.5],
      ['d', 5],
      ['e', 7],
      ['f', 1],
      ['g', 3],
    ] as const)
      await admin.query('UPDATE products SET sale_price=$3 WHERE store_id=$1 AND id=$2', [
        storeId,
        id(external),
        price,
      ]);

    // A: vencido há 3 dias (4 un.), urgente em 2 dias (5 un.) e em dia em 40 dias (7 un.).
    await count('a', [
      [-3, 4],
      [2, 5],
      [40, 7],
    ]);
    // B: atenção em 10 dias (8 un.), urgente amanhã (6 un.), em dia em 20 dias (3 un.).
    await count('b', [
      [10, 8],
      [1, 6],
      [20, 3],
    ]);
    // C, sem preço: vence hoje (3 un.).
    await count('c', [[0, 3]]);
    // D: contagem inicial aberta, ainda não confirmada. E: nunca contado.
    await count('d', [[4, 50]], false);
    // F: contado e recontado; só a recontagem vale.
    await count('f', [[5, 9]]);
    await count('f', [[8, 2]]);
    // G: contado e depois inativado no sistema da loja; o estoque continua na loja.
    await count('g', [[3, 1]]);
    await admin.query('UPDATE products SET active=false WHERE store_id=$1 AND id=$2', [
      storeId,
      id('g'),
    ]);

    // Venda de 6 unidades de B: zera o lote de amanhã, que vence antes (FEFO).
    const { rows } = await admin.query<{ now: string }>(
      `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`,
    );
    const sale = await ok<{ id: string }>(
      '/integrations/movement-batches',
      'POST',
      {
        externalBatchId: randomUUID(),
        events: [
          {
            externalEventId: randomUUID(),
            externalProductId: 'b',
            type: 'SALE',
            quantity: 6,
            occurredAt: rows[0]!.now,
          },
        ],
      },
      apiKey,
    );
    await ctx.integration.process(storeId, sale.id);
    await ctx.prisma.tenant(storeId, (tx) => ctx.inventory.rebuild(tx, storeId, id('b')));
    // Baixa manual de 2 no lote de atenção de B, e exclusão do lote em dia de B.
    // O lote de amanhã, zerado pela venda, já saiu dos ativos.
    const [attention, kept] = await lots('b');
    expect(attention!.expiresOn).toBe(await day(10));
    await ok(`/inventory/records/${attention!.id}/write-off`, 'POST', {
      expectedVersion: attention!.version,
      quantity: 2,
    });
    expect(kept!.expiresOn).toBe(await day(20));
    await ok(`/inventory/records/${kept!.id}/delete`, 'POST', { expectedVersion: kept!.version });
  });

  afterAll(async () => {
    await ctx?.app.close();
    await jobs?.stop();
    if (admin) {
      await admin.query("DELETE FROM pgboss.job WHERE data->>'storeId'=$1", [storeId]);
      await admin.query('UPDATE product_inventory SET epoch_id=NULL WHERE store_id=$1', [storeId]);
      for (const table of [
        'notification_reads',
        'notifications',
        'movement_allocations',
        'stock_projections',
        'projection_runs',
        'movement_resolutions',
        'reconciliation_issues',
        'stock_movements',
        'integration_events',
        'import_batches',
        'stock_records',
        'inventory_epochs',
        'count_lines',
        'count_sessions',
        'product_inventory',
        'product_barcodes',
        'products',
        'integration_keys',
        'integration_connections',
        'command_receipts',
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

  it('o Início mostra só os lotes com saldo de produtos com contagem, com os valores exatos', async () => {
    const dashboard = await ok<{
      trackedProducts: number;
      expiredRecords: number;
      atRiskRecords: number;
      stockValue: number;
      expiringValue: number;
      expiredValue: number;
      unpricedLots: number;
      levels: { name: string; lots: number; units: number; value: number }[];
      upcomingWeeks: { fromDays: number; lots: number; units: number; value: number }[];
    }>('/dashboard/summary');
    // A, B, C, F e G; D (contagem aberta) e E não.
    expect(dashboard.trackedProducts).toBe(5);
    // Vencido: A (4 × R$ 10).
    expect(dashboard.expiredRecords).toBe(1);
    expect(dashboard.expiredValue).toBe(40);
    // A vencer, nos níveis que avisam: A urgente (5 × 10), B atenção (6 × 2,50), C (sem preço),
    // F atenção (2 × 1) e G urgente (1 × 3).
    expect(dashboard.atRiskRecords).toBe(5);
    expect(dashboard.expiringValue).toBe(70);
    // Tudo com saldo: 40 + 50 + 70 (A em dia, 7 × 10) + 15 + 2 + 3.
    expect(dashboard.stockValue).toBe(180);
    expect(dashboard.unpricedLots).toBe(1);
    expect(dashboard.levels).toEqual([
      expect.objectContaining({ name: 'Vencido', lots: 1, units: 4, value: 40 }),
      expect.objectContaining({ name: 'Urgente', lots: 3, units: 9, value: 53 }),
      expect.objectContaining({ name: 'Atenção', lots: 2, units: 8, value: 17 }),
      expect.objectContaining({ name: 'Em dia', lots: 1, units: 7, value: 70 }),
    ]);
    expect(
      dashboard.upcomingWeeks.map(({ fromDays, lots, units, value }) => [
        fromDays,
        lots,
        units,
        value,
      ]),
    ).toEqual([
      [0, 3, 9, 53],
      [7, 2, 8, 17],
      [14, 0, 0, 0],
      [21, 0, 0, 0],
      [28, 0, 0, 0],
      [35, 1, 7, 70],
    ]);
  });

  it('Validades, lista de Produtos e página do produto dão os mesmos números', async () => {
    const summary = await ok<{
      items: { name: string; lots: number; units: number; value: number }[];
    }>('/inventory/expiries/summary');
    expect(summary.items.map(({ name, lots, units, value }) => [name, lots, units, value])).toEqual(
      [
        ['Vencido', 1, 4, 40],
        ['Urgente', 3, 9, 53],
        ['Atenção', 2, 8, 17],
        ['Em dia', 1, 7, 70],
      ],
    );
    const all = await ok<{ items: { productId: string; quantity: number }[] }>(
      '/inventory/expiries?limit=100',
    );
    expect(all.items).toHaveLength(7);
    // Só os níveis que avisam: tudo menos o lote em dia de A.
    const notifying = await ok<{ items: unknown[] }>('/inventory/expiries?limit=100&notify=true');
    expect(notifying.items).toHaveLength(6);
    const products = await ok<{
      items: { productName: string; trackingStatus: string; estimatedQuantity: number }[];
    }>('/inventory?limit=50');
    expect(
      products.items.map((item) => [item.productName, item.trackingStatus, item.estimatedQuantity]),
    ).toEqual([
      ['Produto A', 'TRACKED', 16],
      ['Produto B', 'TRACKED', 6],
      ['Produto C', 'TRACKED', 3],
      ['Produto F', 'TRACKED', 2],
      ['Produto G', 'TRACKED', 1],
      ['Produto D', 'UNTRACKED', 0],
      ['Produto E', 'UNTRACKED', 0],
    ]);
    for (const external of ['a', 'b', 'c', 'f', 'g']) {
      const detail = await ok<{ records: Lot[]; totalQuantity: number }>(
        `/inventory/products/${id(external)}`,
      );
      const listed = all.items.filter((item) => item.productId === id(external));
      expect(detail.records).toHaveLength(listed.length);
      expect(detail.totalQuantity).toBe(listed.reduce((sum, item) => sum + item.quantity, 0));
    }
    const open = await ok<{ records: Lot[]; totalQuantity: number }>(
      `/inventory/products/${id('d')}`,
    );
    expect(open).toMatchObject({ records: [], totalQuantity: 0 });
  });

  it('a conferência refaz a conta e acha qualquer número da tela que não bata', async () => {
    const clean = await audit.check(storeId);
    expect(clean).toMatchObject({ products: 5, lots: 7, pending: [], differences: [] });
    // Um saldo gravado errado num lote de A: a conferência aponta o lote e os totais.
    const [, urgent] = await lots('a');
    await admin.query(
      'UPDATE stock_projections SET quantity=quantity+1 WHERE store_id=$1 AND record_id=$2',
      [storeId, urgent!.id],
    );
    const broken = await audit.check(storeId);
    expect(broken.differences).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ where: expect.stringContaining('saldo'), expected: 5, shown: 6 }),
        expect.objectContaining({
          where: 'Início: valor em estoque (centavos)',
          expected: 18_000,
          shown: 19_000,
        }),
      ]),
    );
    await admin.query(
      'UPDATE stock_projections SET quantity=quantity-1 WHERE store_id=$1 AND record_id=$2',
      [storeId, urgent!.id],
    );
    expect((await audit.check(storeId)).differences).toEqual([]);
  });
});
