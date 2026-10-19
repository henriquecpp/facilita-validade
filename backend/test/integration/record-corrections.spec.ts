import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { hash, argon2id } from 'argon2';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/bootstrap/app.js';
import { Jobs } from '../../src/shared/infrastructure/jobs.js';
import { stableId } from '../../src/modules/integration/adapters/out/prisma-integration.js';
import { testCnpj } from '../support/cnpj.js';

/**
 * Baixa manual, edição e exclusão de lote pela API (reunião de 16/10/2026, AV05 a AV08;
 * especificação de estoque, seção 4 e cenários E33 a E37).
 */
describe('Correções de lote pela API', () => {
  const storeId = randomUUID(),
    ownerId = randomUUID(),
    operatorId = randomUUID(),
    cnpj = testCnpj();
  const password = 'TesteCorrecoes!2026';
  let admin: Pool, jobs: Jobs, ctx: Awaited<ReturnType<typeof createApp>>;
  let owner: string, operator: string, apiKey: string, connectionId: string, productId: string;
  const inDays = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  interface Lot {
    id: string;
    expiresOn: string;
    quantity: number;
    version: number;
    launchedQuantity: number;
    soldQuantity: number;
    writtenOffQuantity: number;
    status: string;
    launchedAt: string;
    launchedBy: string | null;
    deletedBy: string | null;
    levelName: string | null;
  }
  interface Detail {
    records: Lot[];
    totalQuantity: number;
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
  const detail = () => ok<Detail>(`/inventory/products/${productId}`);
  const closed = async () =>
    (await ok<{ items: Lot[] }>(`/inventory/products/${productId}/closed-records`)).items;
  async function sell(quantity: number) {
    const batch = await ok<{ id: string }>(
      '/integrations/movement-batches',
      'POST',
      {
        externalBatchId: randomUUID(),
        events: [
          {
            externalEventId: randomUUID(),
            externalProductId: 'iogurte',
            type: 'SALE',
            quantity,
            occurredAt: (
              await admin.query<{ now: string }>(
                `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`,
              )
            ).rows[0]!.now,
          },
        ],
      },
      apiKey,
    );
    await ctx.integration.process(storeId, batch.id);
    await ctx.prisma.tenant(storeId, (tx) => ctx.inventory.rebuild(tx, storeId, productId));
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await admin.query(
      "INSERT INTO stores(id,cnpj_normalized,name) VALUES($1,$2,'Loja Correções')",
      [storeId, cnpj],
    );
    await admin.query('INSERT INTO store_settings(store_id) VALUES($1)', [storeId]);
    const passwordHash = await hash(password, {
      type: argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
    for (const [id, username, role] of [
      [ownerId, 'dono', 'OWNER'],
      [operatorId, 'repositor', 'OPERATOR'],
    ])
      await admin.query(
        'INSERT INTO store_users(id,store_id,username,username_normalized,password_hash,role,must_change_password) VALUES($1,$2,$3,$3,$4,$5,false)',
        [id, storeId, username, passwordHash, role],
      );
    jobs = new Jobs();
    await jobs.start();
    ctx = await createApp({
      jobs,
      jwtSecret: 'test-record-corrections-secret-at-least-32-bytes',
      notificationChannels: [],
    });
    const login = async (username: string) => {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/v1/auth/mobile/login',
        payload: { cnpj, username, password },
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.json().accessToken as string;
    };
    owner = await login('dono');
    operator = await login('repositor');
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
        products: [{ externalProductId: 'iogurte', description: 'Iogurte', barcodes: ['789'] }],
      },
      apiKey,
    );
    await ctx.integration.process(storeId, catalog.id);
    productId = stableId(storeId, connectionId, 'iogurte', 'product');
    // Contagem inicial pelo repositor: A = 100 vence antes de B = 50.
    let session = await ok<{ id: string; version: number }>(
      '/count-sessions',
      'POST',
      { productId },
      operator,
    );
    session = await ok(
      `/count-sessions/${session.id}/lines`,
      'PUT',
      {
        expectedVersion: session.version,
        lines: [
          { id: randomUUID(), expiresOn: inDays(3), quantity: 100 },
          { id: randomUUID(), expiresOn: inDays(20), quantity: 50 },
        ],
      },
      operator,
    );
    await ok(
      `/count-sessions/${session.id}/confirm`,
      'POST',
      { expectedVersion: session.version, completeConfirmed: true },
      operator,
    );
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

  it('mostra lançado, vendido, saldo, quem lançou, quando e o nível de cada lote', async () => {
    const lots = (await detail()).records;
    expect(lots.map((lot) => [lot.launchedQuantity, lot.soldQuantity, lot.quantity])).toEqual([
      [100, 0, 100],
      [50, 0, 50],
    ]);
    expect(lots.every((lot) => lot.launchedBy === 'repositor' && lot.status === 'PENDING')).toBe(
      true,
    );
    expect(Date.parse(lots[0]!.launchedAt)).toBeGreaterThan(Date.now() - 600_000);
    expect(lots.map((lot) => lot.levelName)).toEqual(['Urgente', 'Em dia']);
  });

  it('E33: baixa manual do repositor reduz só o lote, e a venda seguinte consome o resto', async () => {
    await sell(50);
    let [a] = (await detail()).records;
    const above = await call(
      `/inventory/records/${a!.id}/write-off`,
      'POST',
      { expectedVersion: a!.version, quantity: 51 },
      operator,
    );
    expect(above.statusCode).toBe(422);
    expect(above.json()).toMatchObject({ code: 'WRITE_OFF_ABOVE_BALANCE' });
    const written = await ok<Detail>(
      `/inventory/records/${a!.id}/write-off`,
      'POST',
      { expectedVersion: a!.version, quantity: 20, reason: ' Embalagem estufada ' },
      operator,
    );
    [a] = written.records;
    expect(a).toMatchObject({
      quantity: 30,
      soldQuantity: 50,
      writtenOffQuantity: 20,
      status: 'PENDING',
    });
    // Versão antiga: alguém mexeu no lote antes.
    const stale = await call(
      `/inventory/records/${a!.id}/write-off`,
      'POST',
      { expectedVersion: a!.version - 1, quantity: 1 },
      operator,
    );
    expect(stale.statusCode).toBe(409);
    await sell(30);
    const lots = (await detail()).records;
    expect(lots.map((lot) => lot.quantity)).toEqual([50]);
    expect((await closed())[0]).toMatchObject({
      id: a!.id,
      status: 'BOTH',
      soldQuantity: 80,
      writtenOffQuantity: 20,
    });
    // As vendas do lote: o lançamento não é movimento; as duas vendas e a baixa são.
    const history = await ok<{
      items: {
        type: string;
        allocatedQuantity: number | null;
        reason: string | null;
        actorName: string | null;
      }[];
    }>(`/inventory/products/${productId}/history?recordId=${a!.id}`);
    expect(history.items.map(({ type, allocatedQuantity }) => [type, allocatedQuantity])).toEqual([
      ['SALE', 30],
      ['MANUAL_WRITE_OFF', 20],
      ['SALE', 50],
    ]);
    expect(history.items[1]).toMatchObject({
      reason: 'Embalagem estufada',
      actorName: 'repositor',
    });
    // O histórico de ações também mostra quantidade e motivo; a baixa não fica escondida
    // atrás do antigo rótulo "Vendas". Dados de autenticação não entram nos detalhes.
    const audit = await ok<{ items: { action: string; entityId: string; details?: unknown }[] }>(
      '/audit-events',
    );
    expect(
      audit.items.find(
        (event) => event.action === 'inventory.write-off' && event.entityId === a!.id,
      ),
    ).toMatchObject({ details: { quantity: 20, reason: 'Embalagem estufada' } });
    expect(
      audit.items
        .filter((event) => event.action.startsWith('AUTH_'))
        .every((event) => event.details === undefined),
    ).toBe(true);
  });

  it('E36: só o proprietário edita, a edição vale dali em diante e não desce abaixo do que saiu', async () => {
    let [b] = (await detail()).records;
    const body = { expectedVersion: b!.version, quantity: 60 };
    expect((await call(`/inventory/records/${b!.id}`, 'PATCH', body, operator)).statusCode).toBe(
      403,
    );
    await sell(10);
    [b] = (await detail()).records;
    expect(b).toMatchObject({ quantity: 40, soldQuantity: 10 });
    const below = await call(`/inventory/records/${b!.id}`, 'PATCH', {
      expectedVersion: b!.version,
      quantity: 9,
    });
    expect(below.statusCode).toBe(422);
    expect(below.json()).toMatchObject({ code: 'EDIT_BELOW_ALLOCATED' });
    const same = await call(`/inventory/records/${b!.id}`, 'PATCH', {
      expectedVersion: b!.version,
      quantity: 50,
      expiresOn: b!.expiresOn,
    });
    expect(same.json()).toMatchObject({ code: 'NO_CHANGES' });
    const edited = await ok<Detail>(`/inventory/records/${b!.id}`, 'PATCH', {
      expectedVersion: b!.version,
      quantity: 60,
      expiresOn: inDays(25),
    });
    expect(edited.records[0]).toMatchObject({
      quantity: 50,
      launchedQuantity: 60,
      soldQuantity: 10,
      expiresOn: inDays(25),
    });
    const history = await ok<{
      items: {
        type: string;
        quantity: number | null;
        previousQuantity: number | null;
        actorName: string | null;
      }[];
    }>(`/inventory/products/${productId}/history?recordId=${b!.id}`);
    expect(history.items[0]).toMatchObject({
      type: 'RECORD_EDIT',
      quantity: 60,
      previousQuantity: 50,
      actorName: 'dono',
    });
  });

  it('E35: excluir lote com vendas refaz as baixas; o lote fica no histórico como Excluído', async () => {
    const receipt = await ok<Detail>(
      '/inventory/receipts',
      'POST',
      { productId, quantity: 5, expiresOn: inDays(30), note: 'Lançado no coletor' },
      operator,
    );
    const c = receipt.records.find((lot) => lot.launchedQuantity === 5)!;
    expect(c).toMatchObject({ launchedBy: 'repositor', soldQuantity: 0 });
    // A venda seguinte sai de B, que vence antes.
    await sell(4);
    let [b] = (await detail()).records;
    expect(b).toMatchObject({ quantity: 46, soldQuantity: 14 });
    const deleted = await ok<Detail>(
      `/inventory/records/${b!.id}/delete`,
      'POST',
      { expectedVersion: b!.version },
      operator,
    );
    // As 14 de B, lançado antes de C, não cabem em C: só as 4 posteriores a C passam para ele.
    expect(deleted.records.map((lot) => [lot.id, lot.quantity, lot.soldQuantity])).toEqual([
      [c.id, 1, 4],
    ]);
    expect((await closed()).find((lot) => lot.id === b!.id)).toMatchObject({
      status: 'DELETED',
      deletedBy: 'repositor',
      launchedQuantity: 60,
    });
    const again = await call(`/inventory/records/${b!.id}/delete`, 'POST', {
      expectedVersion: b!.version + 1,
    });
    expect(again.json()).toMatchObject({ code: 'RECORD_DELETED' });
    [b] = (await detail()).records;
    expect(b!.id).toBe(c.id);
  });

  it('bloqueia correção durante contagem aberta', async () => {
    const [lot] = (await detail()).records;
    const session = await ok<{ id: string; version: number }>('/count-sessions', 'POST', {
      productId,
    });
    try {
      const blocked = await call(`/inventory/records/${lot!.id}/write-off`, 'POST', {
        expectedVersion: lot!.version,
        quantity: 1,
      });
      expect(blocked.statusCode).toBe(409);
      expect(blocked.json()).toMatchObject({ code: 'COUNT_ACTIVE' });
    } finally {
      await ok(`/count-sessions/${session.id}/cancel`, 'POST', {
        expectedVersion: session.version,
        reason: 'Teste de bloqueio',
      });
    }
  });
});
