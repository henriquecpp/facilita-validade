import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { hash, argon2id } from 'argon2';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/bootstrap/app.js';
import { Jobs } from '../../src/shared/infrastructure/jobs.js';
import { stableId } from '../../src/modules/integration/adapters/out/prisma-integration.js';
import { SAFETY_FACTOR } from '../../src/modules/inventory/domain/sales-forecast.js';
import {
  recordDailySales,
  refreshSalesRates,
} from '../../src/modules/inventory/adapters/out/sales-rates.js';
import { testCnpj } from '../support/cnpj.js';

/**
 * Previsão de venda (pedido do piloto, 20/11/2026). Níveis padrão da loja: Urgente de 0 a 5
 * dias e Atenção de 6 a 15, os dois avisam.
 *
 * A média vem das vendas do dia de todo o catálogo (como a Pagonet devolve), dos últimos 6
 * meses: 20 dias lidos com venda na loja.
 * - A vendeu 10 un. em 19 desses dias: 9,5 por dia. Um dia lido sem nenhuma venda na loja e uma
 *   venda de 7 meses atrás não contam. Lotes: 2 un. vencendo amanhã, 20 em 10 dias, 30 em 12 e
 *   100 em 13. Com 80% da média (7,6 por dia), os de 10 e 12 dias vendem a tempo e o de 13 deve
 *   sobrar.
 * - B e C não venderam nada: o lote inteiro deve sobrar.
 * - D não é controlado, mas vende todo dia: conta para os dias da loja.
 */
describe('Previsão de venda', () => {
  const storeId = randomUUID(),
    ownerId = randomUUID(),
    cnpj = testCnpj();
  const password = 'TestePrevisao!2026';
  let admin: Pool, jobs: Jobs, ctx: Awaited<ReturnType<typeof createApp>>;
  let owner: string, connectionId: string;
  const id = (external: string) => stableId(storeId, connectionId, external, 'product');

  interface Lot {
    id: string;
    expiresOn: string;
    quantity: number;
    daysToExpiry: number;
    forecastLeftover?: number | null;
  }

  function call(path: string, method: InjectOptions['method'] = 'GET', body?: unknown) {
    return ctx.app.inject({
      method,
      url: `/api/v1${path}`,
      headers: {
        authorization: `Bearer ${owner}`,
        'idempotency-key': randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      payload: body ? JSON.stringify(body) : undefined,
    });
  }
  async function ok<T>(path: string, method: InjectOptions['method'] = 'GET', body?: unknown) {
    const response = await call(path, method, body);
    expect(response.statusCode, `${method} ${path}: ${response.body}`).toBeLessThan(300);
    return response.json() as T;
  }
  async function day(days: number) {
    const { rows } = await admin.query<{ day: string }>(
      `SELECT to_char((clock_timestamp() AT TIME ZONE timezone)::date + $2::int, 'YYYY-MM-DD') AS day
         FROM stores WHERE id = $1`,
      [storeId, days],
    );
    return rows[0]!.day;
  }
  async function count(external: string, lines: [number, number][]) {
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
    await ok(`/count-sessions/${session.id}/confirm`, 'POST', {
      expectedVersion: session.version,
      completeConfirmed: true,
    });
  }
  /** Vendas de um dia encerrado, como a leitura da Pagonet grava. */
  async function sold(daysAgo: number, sales: [string, number][]) {
    const date = await day(-daysAgo);
    await ctx.prisma.tenant(storeId, (tx) =>
      recordDailySales(
        tx,
        storeId,
        connectionId,
        date,
        sales.map(([externalProductId, quantity]) => ({ externalProductId, quantity })),
      ),
    );
  }
  const refreshRates = () => ctx.prisma.tenant(storeId, (tx) => refreshSalesRates(tx, storeId));
  const detail = (external: string) =>
    ok<{ records: Lot[]; dailySales: number | null; salesHistoryDays: number | null }>(
      `/inventory/products/${id(external)}`,
    );
  async function expiryAlerts() {
    const { items } = await ok<{ items: { productName: string; expiresOn: string }[] }>(
      '/notifications?type=EXPIRY&limit=100',
    );
    return items.map((item) => `${item.productName} ${item.expiresOn}`).sort();
  }
  async function setForecastAlerts(enabled: boolean) {
    const settings = await ok<{ version: number; timezone: string }>('/store/settings');
    const saved = await ok<{ salesForecastAlerts: boolean }>('/store/settings', 'PATCH', {
      expectedVersion: settings.version,
      timezone: settings.timezone,
      salesForecastAlerts: enabled,
    });
    expect(saved.salesForecastAlerts).toBe(enabled);
    // O job da reavaliação roda no worker; aqui, direto.
    await ctx.notifications.evaluate(storeId);
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await admin.query("INSERT INTO stores(id,cnpj_normalized,name) VALUES($1,$2,'Loja Previsão')", [
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
      jwtSecret: 'test-sales-forecast-secret-at-least-32-bytes!',
      notificationChannels: [],
    });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mobile/login',
      payload: { cnpj, username: 'dono', password },
    });
    expect(login.statusCode, login.body).toBe(200);
    owner = login.json().accessToken;
    connectionId = (await ok<{ id: string }>('/integration-connections', 'POST', { name: 'ERP' }))
      .id;
    const apiKey = (
      await ok<{ key: string }>('/integration-keys', 'POST', {
        connectionId,
        scopes: ['catalog:write'],
      })
    ).key;
    const catalog = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/catalog-batches',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      payload: JSON.stringify({
        externalBatchId: randomUUID(),
        products: ['a', 'b', 'c', 'd'].map((external) => ({
          externalProductId: external,
          description: `Produto ${external.toUpperCase()}`,
          barcodes: [],
        })),
      }),
    });
    expect(catalog.statusCode, catalog.body).toBeLessThan(300);
    await ctx.integration.process(storeId, catalog.json().id);

    await count('a', [
      [1, 2],
      [10, 20],
      [12, 30],
      [13, 100],
    ]);
    await count('b', [[3, 4]]);
    await count('c', [[8, 5]]);
    for (let daysAgo = 1; daysAgo <= 20; daysAgo++)
      await sold(
        daysAgo,
        daysAgo === 7
          ? [['d', 3]]
          : [
              ['a', 6],
              ['a', 4],
              ['d', 3],
            ],
      );
    // Loja sem nenhuma venda no dia (fechada, ou a origem sem dados): não entra na média.
    await sold(21, []);
    // Fora da janela de 6 meses. Item de código fora do catálogo fica de fora.
    await sold(213, [['a', 1000]]);
    await sold(2, [
      ['a', 6],
      ['a', 4],
      ['d', 3],
      ['desconhecido', 50],
    ]);
    await refreshRates();
    await ctx.notifications.evaluate(storeId);
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
        'product_sales_rates',
        'product_daily_sales',
        'sales_days',
        'inventory_checkpoints',
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

  it('calcula a média dos dias lidos com venda na loja, nos últimos 6 meses', async () => {
    const a = await detail('a');
    expect(a.dailySales).toBe(9.5);
    expect(a.salesHistoryDays).toBe(20);
    const b = await detail('b');
    expect(b.dailySales).toBe(0);
    expect(b.salesHistoryDays).toBe(20);
    expect(b.records[0]!.forecastLeftover).toBe(4);
    const { rows } = await admin.query<{ units: string; items: number }>(
      `SELECT units::text, items FROM sales_days WHERE store_id = $1 AND day = $2::date`,
      [storeId, await day(-2)],
    );
    // A releitura do dia substitui a anterior; o item fora do catálogo conta no dia da loja.
    expect(rows[0]).toEqual({ units: '63.000', items: 4 });
  });

  it('sem 7 dias com venda lidos não há previsão', async () => {
    await admin.query('UPDATE sales_days SET items = 0 WHERE store_id = $1 AND day < $2::date', [
      storeId,
      await day(-6),
    ]);
    await refreshRates();
    const a = await detail('a');
    expect(a.dailySales).toBeNull();
    expect(a.salesHistoryDays).toBe(6);
    expect(a.records.every((lot) => lot.forecastLeftover === null)).toBe(true);
    await admin.query(
      'UPDATE sales_days SET items = 1 WHERE store_id = $1 AND items = 0 AND day > $2::date',
      [storeId, await day(-21)],
    );
    await refreshRates();
    expect((await detail('a')).dailySales).toBe(9.5);
  });

  it('prevê a sobra de cada lote na ordem da baixa automática', async () => {
    const { rows } = await admin.query<{ daily_sales: string; rest: string }>(
      `SELECT r.daily_sales,
              1 - extract(epoch FROM (clock_timestamp() AT TIME ZONE s.timezone)::time) / 86400 AS rest
         FROM product_sales_rates r JOIN stores s ON s.id = r.store_id
        WHERE r.store_id = $1 AND r.product_id = $2`,
      [storeId, id('a')],
    );
    const rate = Number(rows[0]!.daily_sales) * SAFETY_FACTOR;
    // O que resta de hoje também vende: o lote sai até o fim do dia da validade.
    const rest = Number(rows[0]!.rest);
    const { records } = await detail('a');
    expect(records.map((lot) => lot.quantity)).toEqual([2, 20, 30, 100]);
    let before = 0;
    const expected = records.map((lot) => {
      const left = Math.min(
        lot.quantity,
        Math.max(0, before + lot.quantity - rate * (lot.daysToExpiry + rest)),
      );
      before += lot.quantity;
      return Math.ceil(left);
    });
    // Até o fim do 13º dia, de 98,8 a 106,4 vendidos; os 52 dos lotes anteriores saem antes.
    expect(expected.slice(0, 3)).toEqual([0, 0, 0]);
    expect(expected[3]).toBeGreaterThanOrEqual(46);
    expect(expected[3]).toBeLessThanOrEqual(54);
    expect(records.map((lot) => lot.forecastLeftover)).toEqual(expected);
    const { items } = await ok<{ items: Lot[] }>('/inventory/expiries?limit=100');
    const byId = new Map(items.map((lot) => [lot.id, lot.forecastLeftover]));
    expect(records.map((lot) => byId.get(lot.id))).toEqual(expected);
    const [cLot] = (await detail('c')).records;
    expect(cLot!.forecastLeftover).toBe(5);
  });

  it('com a opção desligada, todos os lotes dos níveis que avisam alertam', async () => {
    const alerts = await expiryAlerts();
    expect(alerts).toHaveLength(6);
    const notifying = await ok<{ items: unknown[] }>('/inventory/expiries?limit=100&notify=true');
    expect(notifying.items).toHaveLength(6);
    const dashboard = await ok<{ atRiskRecords: number; sellingInTimeRecords: number }>(
      '/dashboard/summary',
    );
    expect(dashboard.atRiskRecords).toBe(6);
    // Os de 10 e 12 dias; o que vence amanhã sempre conta como risco.
    expect(dashboard.sellingInTimeRecords).toBe(2);
  });

  it('com a opção ligada, o lote previsto para vender a tempo deixa de alertar', async () => {
    await setForecastAlerts(true);
    expect(await expiryAlerts()).toEqual(
      [
        `Produto A ${await day(1)}`,
        `Produto A ${await day(13)}`,
        `Produto B ${await day(3)}`,
        `Produto C ${await day(8)}`,
      ].sort(),
    );
    const notifying = await ok<{ items: { id: string }[] }>(
      '/inventory/expiries?limit=100&notify=true',
    );
    expect(notifying.items).toHaveLength(4);
    // O número de lotes a vencer do Início continua o dos níveis que avisam.
    const dashboard = await ok<{ atRiskRecords: number; sellingInTimeRecords: number }>(
      '/dashboard/summary',
    );
    expect(dashboard.atRiskRecords).toBe(6);
    expect(dashboard.sellingInTimeRecords).toBe(2);
    expect(
      (await ok<{ salesForecastAlerts: boolean }>('/store/settings')).salesForecastAlerts,
    ).toBe(true);
  });

  it('desligar a opção traz os alertas de volta', async () => {
    await setForecastAlerts(false);
    expect(await expiryAlerts()).toHaveLength(6);
  });
});
