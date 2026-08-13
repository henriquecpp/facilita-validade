import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { hash, argon2id } from 'argon2';
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import type { InjectOptions } from 'fastify';
import { createApp } from '../../src/bootstrap/app.js';
import { Database } from '../../src/shared/infrastructure/database.js';
import { Jobs } from '../../src/shared/infrastructure/jobs.js';
import { stableId } from '../../src/modules/integration/adapters/out/prisma-integration.js';
import { sqlState } from '../../src/shared/infrastructure/database-errors.js';
function cnpj() {
  const base = String(
    BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`) % 1000000000000n,
  ).padStart(12, '0');
  const dv = (s: string) => {
    let sum = 0,
      w = 2;
    for (let i = s.length - 1; i >= 0; i--) {
      sum += Number(s[i]) * w;
      w = w === 9 ? 2 : w + 1;
    }
    return sum % 11 < 2 ? 0 : 11 - (sum % 11);
  };
  return base + dv(base) + dv(base + dv(base));
}
describe('API de estoque com PostgreSQL, RLS e fila reais', () => {
  const stores = [randomUUID(), randomUUID()],
    users = [randomUUID(), randomUUID()],
    cnpjs = [cnpj(), cnpj()];
  const password = 'TesteIntegracao!2026';
  let db: Database, admin: Pool, jobs: Jobs, ctx: Awaited<ReturnType<typeof createApp>>;
  let tokens: string[], connectionId: string, apiKey: string, productId: string;
  const expiries = [
    new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10),
    new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
  ];
  async function request(
    path: string,
    method: InjectOptions['method'] = 'GET',
    body?: unknown,
    token = tokens[0],
    key = randomUUID(),
  ) {
    return ctx.app.inject({
      method,
      url: `/api/v1${path}`,
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': key,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      payload: body ? JSON.stringify(body) : undefined,
    });
  }
  async function ok<T>(
    path: string,
    method: InjectOptions['method'] = 'GET',
    body?: unknown,
    token = tokens[0],
    key = randomUUID(),
  ): Promise<T> {
    const r = await request(path, method, body, token, key);
    expect(r.statusCode, `${method} ${path}: ${r.body}`).toBeLessThan(300);
    return r.json() as T;
  }
  async function count(quantityA = 20, quantityB = 50) {
    let session = await ok<{ id: string; version: number }>('/count-sessions', 'POST', {
      productId,
    });
    session = await ok(`/count-sessions/${session.id}/lines`, 'PUT', {
      expectedVersion: session.version,
      lines: [
        { id: randomUUID(), expiresOn: expiries[0], quantity: quantityA },
        { id: randomUUID(), expiresOn: expiries[1], quantity: quantityB },
      ],
    });
    return ok<{ id: string; cutoffAt: string; version: number }>(
      `/count-sessions/${session.id}/confirm`,
      'POST',
      { expectedVersion: session.version, completeConfirmed: true },
    );
  }
  async function importEvents(events: unknown[], externalBatchId = randomUUID()) {
    const batch = await ok<{ id: string }>(
      '/integrations/movement-batches',
      'POST',
      { externalBatchId, events },
      apiKey,
    );
    await ctx.integration.process(stores[0]!, batch.id);
    await ctx.prisma.tenant(stores[0]!, (tx) => ctx.inventory.rebuild(tx, stores[0]!, productId));
    return batch;
  }
  async function now() {
    return (
      await admin.query<{ instant: string }>(
        // Instante do banco com microssegundos, como o domínio compara.
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS instant`,
      )
    ).rows[0]!.instant;
  }
  beforeAll(async () => {
    if (!['development', 'test'].includes(process.env.NODE_ENV ?? ''))
      throw new Error('Testes de integração exigem ambiente development/test.');
    db = new Database();
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    jobs = new Jobs();
    await jobs.start();
    const passwordHash = await hash(password, {
      type: argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    for (let i = 0; i < 2; i++) {
      await admin.query('INSERT INTO stores(id,cnpj_normalized,name) VALUES($1,$2,$3)', [
        stores[i],
        cnpjs[i],
        `Loja API ${i}`,
      ]);
      await admin.query('INSERT INTO store_settings(store_id) VALUES($1)', [stores[i]]);
      await admin.query(
        "INSERT INTO store_users(id,store_id,username,username_normalized,password_hash,role,must_change_password) VALUES($1,$2,'api-user','api-user',$3,'OWNER',false)",
        [users[i], stores[i], passwordHash],
      );
    }
    ctx = await createApp({
      database: db,
      jobs,
      jwtSecret: 'test-stock-api-secret-at-least-thirty-two-bytes',
    });
    tokens = [];
    for (let i = 0; i < 2; i++) {
      const r = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/mobile/login',
        payload: { cnpj: cnpjs[i], username: 'api-user', password },
      });
      expect(r.statusCode, r.body).toBe(200);
      tokens.push(r.json().accessToken);
    }
    const connection = await ok<{ id: string }>('/integration-connections', 'POST', {
      name: 'ERP Teste',
    });
    connectionId = connection.id;
    apiKey = (
      await ok<{ key: string }>('/integration-keys', 'POST', {
        connectionId,
        scopes: ['catalog:write', 'movements:write', 'batches:read'],
      })
    ).key;
    const catalog = await ok<{ id: string }>(
      '/integrations/catalog-batches',
      'POST',
      {
        externalBatchId: randomUUID(),
        products: [
          {
            externalProductId: 'iogurte',
            description: 'Iogurte de teste',
            barcodes: ['0001234567895'],
          },
        ],
      },
      apiKey,
    );
    await ctx.integration.process(stores[0]!, catalog.id);
    productId = stableId(stores[0]!, connectionId, 'iogurte', 'product');
  });
  afterAll(async () => {
    await ctx?.app.close();
    await jobs?.stop();
    if (admin) {
      await admin.query("DELETE FROM pgboss.job WHERE data->>'storeId'=ANY($1::text[])", [stores]);
      await admin.query(
        'UPDATE product_inventory SET epoch_id=NULL WHERE store_id=ANY($1::uuid[])',
        [stores],
      );
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
        'password_reset_tokens',
        'refresh_tokens',
        'push_subscriptions',
        'auth_sessions',
        'store_users',
        'expiry_levels',
        'store_settings',
      ])
        await admin.query(`DELETE FROM ${table} WHERE store_id=ANY($1::uuid[])`, [stores]);
      await admin.query('DELETE FROM stores WHERE id=ANY($1::uuid[])', [stores]);
      await admin.end();
    }
    await db?.close();
  });
  it('nega leitura sem tenant, RLS cruzada, FK cruzada e DDL runtime', async () => {
    expect((await db.pool.query('SELECT id FROM products')).rows).toEqual([]);
    expect((await request(`/products/${productId}`, 'GET', undefined, tokens[1])).statusCode).toBe(
      404,
    );
    const crossTenant = await ctx.prisma
      .tenant(stores[1]!, (tx) =>
        tx.product_barcodes.create({
          data: { store_id: stores[1]!, product_id: productId, barcode: 'CROSS' },
        }),
      )
      .catch((error: unknown) => error);
    expect(sqlState(crossTenant)).toBe('23503');
    await expect(db.pool.query('CREATE TABLE forbidden_ddl(id int)')).rejects.toMatchObject({
      code: '42501',
    });
    expect((await db.pool.query('SELECT id FROM products')).rows).toEqual([]);
  });
  it('catálogo começa UNTRACKED, preserva zero inicial e não gera saldo', async () => {
    expect((await ok<{ id: string }>('/products/by-barcode/0001234567895')).id).toBe(productId);
    const detail = await ok<{ trackingStatus: string; totalQuantity: number }>(
      `/inventory/products/${productId}`,
    );
    expect(detail).toMatchObject({ trackingStatus: 'UNTRACKED', totalQuantity: 0 });
    await importEvents([
      {
        externalEventId: 'untracked-sale',
        externalProductId: 'iogurte',
        type: 'SALE',
        quantity: 100,
        occurredAt: await now(),
      },
    ]);
    expect((await ok<{ items: unknown[] }>('/reconciliation-issues')).items).toEqual([]);
  });
  it('confirma contagem absoluta, importa venda FEFO e deduplica reenvio', async () => {
    await count();
    const event = {
      externalEventId: 'sale-25',
      externalProductId: 'iogurte',
      type: 'SALE',
      quantity: 25,
      occurredAt: await now(),
    };
    const batchId = randomUUID();
    const first = await importEvents([event], batchId);
    const second = await importEvents([event], batchId);
    expect(second.id).toBe(first.id);
    const detail = await ok<{ records: { quantity: number }[]; totalQuantity: number }>(
      `/inventory/products/${productId}`,
    );
    // O lote zerado pelas vendas sai da lista ativa e vai para o histórico de lotes.
    expect(detail.records.map((r) => r.quantity)).toEqual([45]);
    expect(detail.totalQuantity).toBe(45);
    const closed = await ok<{
      items: { quantity: number; status: string; soldQuantity: number }[];
    }>(`/inventory/products/${productId}/closed-records`);
    expect(closed.items).toMatchObject([{ quantity: 0, status: 'AUTOMATIC', soldQuantity: 20 }]);
    expect(
      (
        await request(
          '/integrations/movement-batches',
          'POST',
          { externalBatchId: randomUUID(), events: [{ ...event, quantity: 26 }] },
          apiKey,
        )
      ).statusCode,
    ).toBe(409);
  });
  it('venda anterior ao corte não desconta novamente e recontagem substitui saldo', async () => {
    const previous = await now();
    await count(2, 40);
    await importEvents([
      {
        externalEventId: 'old-sale',
        externalProductId: 'iogurte',
        type: 'SALE',
        quantity: 8,
        occurredAt: previous,
      },
    ]);
    expect(
      (await ok<{ totalQuantity: number }>(`/inventory/products/${productId}`)).totalQuantity,
    ).toBe(42);
  });
  it('retry concorrente de entrada confirma uma operação e payload diferente conflita', async () => {
    const key = randomUUID(),
      body = { productId, quantity: 1, expiresOn: expiries[0] };
    const responses = await Promise.all([
      request('/inventory/receipts', 'POST', body, tokens[0], key),
      request('/inventory/receipts', 'POST', body, tokens[0], key),
    ]);
    for (const r of responses) expect(r.statusCode, r.body).toBe(201);
    expect(responses[0]!.json()).toEqual(responses[1]!.json());
    expect(
      (await ok<{ totalQuantity: number }>(`/inventory/products/${productId}`)).totalQuantity,
    ).toBe(43);
    expect(
      (await request('/inventory/receipts', 'POST', { ...body, quantity: 2 }, tokens[0], key))
        .statusCode,
    ).toBe(409);
    const receipt = await ok<{ result: { totalQuantity: number } }>(
      `/operations/${key}?operation=inventory.receipt`,
    );
    expect(receipt.result.totalQuantity).toBe(43);
  });
  it('bloqueia entrada durante contagem e impede sobrescrita de versão', async () => {
    const session = await ok<{ id: string; version: number }>('/count-sessions', 'POST', {
      productId,
    });
    expect(
      (
        await request('/inventory/receipts', 'POST', {
          productId,
          quantity: 1,
          expiresOn: expiries[0],
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await request(`/count-sessions/${session.id}/lines`, 'PUT', {
          expectedVersion: 999,
          lines: [],
        })
      ).statusCode,
    ).toBe(409);
    await ok(`/count-sessions/${session.id}/cancel`, 'POST', {
      expectedVersion: session.version,
      reason: 'Teste de cancelamento',
    });
  });
  it('job e escrita somem juntos no rollback', async () => {
    let jobId: string | null = null;
    await expect(
      ctx.prisma.tenant(stores[0]!, async (tx) => {
        jobId = await jobs.send(tx, stores[0]!, 'inventory.rebuild', { productId });
        await tx.$executeRaw`UPDATE product_inventory SET input_revision = input_revision + 100
          WHERE store_id = ${stores[0]}::uuid AND product_id = ${productId}::uuid`;
        throw new Error('rollback-test');
      }),
    ).rejects.toThrow('rollback-test');
    expect((await admin.query('SELECT id FROM pgboss.job WHERE id=$1', [jobId])).rows).toHaveLength(
      0,
    );
    const detail = await ok<{ inputRevision: number; appliedInputRevision: number }>(
      `/inventory/products/${productId}`,
    );
    expect(detail.inputRevision).toBe(detail.appliedInputRevision);
  });
  it('cancela venda documentalmente e não duplica alerta em replay', async () => {
    await count(3, 0);
    const occurredAt = await now();
    await importEvents([
      {
        externalEventId: 'sale-to-void',
        externalProductId: 'iogurte',
        type: 'SALE',
        quantity: 3,
        occurredAt,
      },
    ]);
    await ctx.notifications.evaluate(stores[0]!, productId);
    const before = await ok<{ items: { id: string }[] }>('/notifications');
    expect(before.items.length).toBeGreaterThan(0);
    await ctx.notifications.evaluate(stores[0]!, productId);
    expect((await ok<{ items: unknown[] }>('/notifications')).items).toHaveLength(
      before.items.length,
    );
    await importEvents([
      {
        externalEventId: 'void-sale',
        externalProductId: 'iogurte',
        type: 'VOID_MOVEMENT',
        originalExternalEventId: 'sale-to-void',
        occurredAt: await now(),
      },
    ]);
    expect(
      (await ok<{ totalQuantity: number }>(`/inventory/products/${productId}`)).totalQuantity,
    ).toBe(3);
  });
  it('separa leitura de alertas por usuário e reabre a revisão após mudar os níveis somente na loja configurada', async () => {
    await ctx.notifications.evaluate(stores[0]!, productId);
    type Alert = { id: string; type: string; levelName: string | null; readAt: string | null };
    const alert = (await ok<{ items: Alert[] }>('/notifications')).items.find(
      (item) => item.levelName === 'Urgente',
    )!;
    expect(alert).toBeDefined();
    await ok(`/notifications/${alert.id}/read`, 'POST');
    expect(
      (await ok<{ items: Alert[] }>('/notifications')).items.find((item) => item.id === alert.id)
        ?.readAt,
    ).not.toBeNull();
    const secondUser = randomUUID();
    await admin.query(
      "INSERT INTO store_users(id,store_id,username,username_normalized,password_hash,role,must_change_password) VALUES($1,$2,'alert-reader','alert-reader',$3,'OPERATOR',false)",
      [
        secondUser,
        stores[0],
        await hash(password, { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      ],
    );
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mobile/login',
      payload: { cnpj: cnpjs[0], username: 'alert-reader', password },
    });
    expect(login.statusCode, login.body).toBe(200);
    const operator = login.json().accessToken as string;
    const otherReader = await ok<{ items: Alert[] }>('/notifications', 'GET', undefined, operator);
    expect(otherReader.items.find((item) => item.id === alert.id)?.readAt).toBeNull();
    expect(
      (await request(`/notifications/${alert.id}/read`, 'POST', undefined, tokens[1])).statusCode,
    ).toBe(404);
    type Levels = { version: number; items: Record<string, unknown>[] };
    const levels = await ok<Levels>('/store/expiry-levels');
    const otherLevels = await ok<Levels>('/store/expiry-levels', 'GET', undefined, tokens[1]);
    // Só o proprietário muda os níveis.
    expect(
      (
        await request(
          '/store/expiry-levels',
          'PUT',
          { expectedVersion: levels.version, levels: levels.items },
          operator,
        )
      ).statusCode,
    ).toBe(403);
    // O lote que vence em 2 dias sai de todos os níveis que avisam: o alerta some.
    const narrowed = await ok<Levels>('/store/expiry-levels', 'PUT', {
      expectedVersion: levels.version,
      levels: [{ name: 'Vencido', maxDays: -1, color: '#c62828', notify: true }],
    });
    await ctx.notifications.evaluate(stores[0]!, productId);
    expect(
      (await ok<{ items: Alert[] }>('/notifications')).items.find((item) => item.id === alert.id),
    ).toBeUndefined();
    expect(await ok('/store/expiry-levels', 'GET', undefined, tokens[1])).toEqual(otherLevels);
    expect(
      (await ok<{ totalQuantity: number }>(`/inventory/products/${productId}`)).totalQuantity,
    ).toBe(3);
    // De volta num nível que avisa: alerta novo para quem já tinha lido, e pendente de push.
    await ok('/store/expiry-levels', 'PUT', {
      expectedVersion: narrowed.version,
      levels: [
        { name: 'Vencido', maxDays: -1, color: '#c62828', notify: true },
        { name: 'Urgente', minDays: 0, maxDays: 5, color: '#ef6c00', notify: true },
      ],
    });
    await ctx.notifications.evaluate(stores[0]!, productId);
    expect(
      (await ok<{ items: Alert[] }>('/notifications')).items.find((item) => item.id === alert.id),
    ).toMatchObject({ type: 'EXPIRY', levelName: 'Urgente', readAt: null });
    const pending = await admin.query<{ push_pending: boolean }>(
      'SELECT push_pending FROM notifications WHERE id=$1',
      [alert.id],
    );
    expect(pending.rows[0]!.push_pending).toBe(true);
  });
  it('rejeita origem web inválida e campos desconhecidos no comando', async () => {
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/web/login',
      headers: { origin: 'https://invalid.example', 'x-csrf-protection': '1' },
      payload: { cnpj: cnpjs[0], username: 'api-user', password },
    });
    expect(login.statusCode).toBe(403);
    expect(
      (
        await request('/inventory/receipts', 'POST', {
          productId,
          quantity: 1,
          expiresOn: expiries[0],
          storeId: stores[1],
        })
      ).statusCode,
    ).toBe(400);
  });
  it('recebe os relatórios da origem, resolve o produto por qualquer EAN e dá baixa', async () => {
    const catalog = await ok<{ id: string; issues: unknown[] }>(
      '/integrations/reports/catalog',
      'POST',
      {
        externalBatchId: randomUUID(),
        // Duas formas de venda do mesmo codprod são produtos separados.
        produtos: [
          { codprod: '100', codformavenda: 'fv-unidade', descricao: 'Iogurte unidade' },
          { codprod: '100', codformavenda: 'fv-bandeja', descricao: 'Iogurte bandeja 6' },
        ],
        // Embalagem trocada: o EAN antigo continua valendo para a mesma forma de venda.
        produtosEan: [
          { codformavenda: 'fv-unidade', ean: '0009990000007' },
          { codformavenda: 'fv-unidade', ean: '0009990000014' },
          { codformavenda: 'fv-bandeja', ean: '0009990000021' },
        ],
      },
      apiKey,
    );
    expect(catalog.issues).toEqual([]);
    await ctx.integration.process(stores[0]!, catalog.id);

    const unidade = stableId(stores[0]!, connectionId, 'fv-unidade', 'product');
    for (const ean of ['0009990000007', '0009990000014']) {
      expect((await ok<{ id: string }>(`/products/by-barcode/${ean}`)).id).toBe(unidade);
    }

    let session = await ok<{ id: string; version: number }>('/count-sessions', 'POST', {
      productId: unidade,
    });
    session = await ok(`/count-sessions/${session.id}/lines`, 'PUT', {
      expectedVersion: session.version,
      lines: [
        { id: randomUUID(), expiresOn: expiries[0], quantity: 10 },
        { id: randomUUID(), expiresOn: expiries[1], quantity: 40 },
      ],
    });
    await ok(`/count-sessions/${session.id}/confirm`, 'POST', {
      expectedVersion: session.version,
      completeConfirmed: true,
    });

    const externalBatchId = randomUUID();
    // Mesmo instante nas duas linhas, de propósito: exercita a soma e a reordenação
    // sempre. Com dois now() separados, o caminho dependia de os dois caírem no mesmo
    // milissegundo — e foi assim que um lote dependente da ordem passou despercebido.
    const instante = await now();
    const vendas = [
      { dataHora: instante, codprod: '100', codformavenda: 'fv-unidade', quantidade: 6 },
      { dataHora: instante, codprod: '100', codformavenda: 'fv-unidade', quantidade: 2 },
    ];
    const sales = await ok<{ id: string }>(
      '/integrations/reports/sales',
      'POST',
      { externalBatchId, vendas },
      apiKey,
    );
    await ctx.integration.process(stores[0]!, sales.id);
    await ctx.prisma.tenant(stores[0]!, (tx) => ctx.inventory.rebuild(tx, stores[0]!, unidade));

    // FEFO: as 8 unidades saem do lote que vence antes.
    const detail = await ok<{ records: { expiresOn: string; quantity: number }[] }>(
      `/inventory/products/${unidade}`,
    );
    expect(detail.records.map((r) => [r.expiresOn, r.quantity])).toEqual([
      [expiries[0], 2],
      [expiries[1], 40],
    ]);

    // Reexportar o mesmo período, com as linhas em outra ordem, não desconta de novo.
    const again = await ok<{ id: string }>(
      '/integrations/reports/sales',
      'POST',
      { externalBatchId, vendas: [...vendas].reverse() },
      apiKey,
    );
    expect(again.id).toBe(sales.id);
    await ctx.integration.process(stores[0]!, again.id);
    await ctx.prisma.tenant(stores[0]!, (tx) => ctx.inventory.rebuild(tx, stores[0]!, unidade));
    expect(
      (await ok<{ records: { quantity: number }[] }>(`/inventory/products/${unidade}`)).records.map(
        (r) => r.quantity,
      ),
    ).toEqual([2, 40]);
  });
});
