import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { hash, argon2id } from 'argon2';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { createApp } from '../../src/bootstrap/app.js';
import { Database } from '../../src/shared/infrastructure/database.js';
import { Jobs } from '../../src/shared/infrastructure/jobs.js';
import type { TenantActor } from '../../src/shared/domain/context.js';
import {
  stableId,
  type MovementInput,
  type IntegrationActor,
} from '../../src/modules/integration/adapters/out/prisma-integration.js';

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

describe('Regressões de integração e leitura consistente com PostgreSQL real', () => {
  const storeId = randomUUID(),
    userId = randomUUID(),
    expiry = '2099-01-01';
  const actor: TenantActor = {
    storeId,
    userId,
    role: 'OWNER',
    sessionId: randomUUID(),
    restricted: false,
  };
  let db: Database,
    admin: Pool,
    jobs: Jobs,
    ctx: Awaited<ReturnType<typeof createApp>>,
    integrationActor: IntegrationActor,
    apiKey: string,
    accessToken: string,
    operatorToken: string;
  async function now() {
    return (
      await admin.query<{ instant: string }>(
        // Instante do banco com microssegundos, como o domínio compara.
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS instant`,
      )
    ).rows[0]!.instant;
  }
  async function product() {
    const externalProductId = randomUUID(),
      id = stableId(storeId, integrationActor.connectionId, externalProductId, 'product');
    await ctx.prisma.tenant(storeId, (tx) =>
      ctx.integration.upsertProduct(tx, storeId, integrationActor.connectionId, {
        externalProductId,
        description: 'Produto de regressão',
        barcodes: [externalProductId],
      }),
    );
    let session = await ctx.inventory.createCount(actor, randomUUID(), id);
    session = await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
      type: 'lines',
      expectedVersion: session.version,
      lines: [{ id: randomUUID(), expiresOn: expiry, lotCode: 'LOTE-A', quantity: 10 }],
    });
    await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
      type: 'confirm',
      expectedVersion: session.version,
      completeConfirmed: true,
    });
    return { id, externalProductId };
  }
  async function importEvents(events: MovementInput[]) {
    const batch = await ctx.integration.ingest(integrationActor, 'MOVEMENTS', {
      externalBatchId: randomUUID(),
      events,
    });
    await ctx.integration.process(storeId, batch.id);
    return batch;
  }
  // Leituras de conferência pelo papel administrativo, filtrando a loja explicitamente.
  async function one<T extends object>(sql: string, values: unknown[]): Promise<T | undefined> {
    return (await admin.query(sql, values)).rows[0] as T | undefined;
  }
  async function status(externalEventId: string) {
    return one<{ status: string }>(
      'SELECT status FROM integration_events WHERE store_id=$1 AND connection_id=$2 AND external_event_id=$3',
      [storeId, integrationActor.connectionId, externalEventId],
    );
  }
  async function fact(externalEventId: string) {
    return one<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM stock_movements WHERE store_id=$1 AND id=$2',
      [storeId, stableId(storeId, integrationActor.connectionId, externalEventId)],
    );
  }
  async function pending(productId: string) {
    return (await one<{ id: string }>(
      "SELECT id FROM reconciliation_issues WHERE store_id=$1 AND product_id=$2 AND status='OPEN' AND code='PENDING_STOCK_IDENTIFICATION'",
      [storeId, productId],
    ))!;
  }
  beforeAll(async () => {
    if (!['development', 'test'].includes(process.env.NODE_ENV ?? ''))
      throw new Error('Testes de integração exigem ambiente development/test.');
    db = new Database();
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    jobs = new Jobs();
    await jobs.start();
    const taxId = cnpj(),
      password = 'TesteEdgeCases!2026';
    await admin.query('INSERT INTO stores(id,cnpj_normalized,name) VALUES($1,$2,$3)', [
      storeId,
      taxId,
      'Loja regressões',
    ]);
    await admin.query('INSERT INTO store_settings(store_id) VALUES($1)', [storeId]);
    await admin.query(
      "INSERT INTO store_users(id,store_id,username,username_normalized,password_hash,role,must_change_password) VALUES($1,$2,'edge-user','edge-user',$3,'OWNER',false)",
      [
        userId,
        storeId,
        await hash(password, { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      ],
    );
    ctx = await createApp({
      database: db,
      jobs,
      jwtSecret: 'test-edge-cases-secret-at-least-thirty-two-bytes',
    });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mobile/login',
      payload: { cnpj: taxId, username: 'edge-user', password },
    });
    expect(login.statusCode, login.body).toBe(200);
    accessToken = login.json().accessToken;
    await admin.query(
      "INSERT INTO store_users(id,store_id,username,username_normalized,password_hash,role,must_change_password) VALUES($1,$2,'edge-operator','edge-operator',$3,'OPERATOR',false)",
      [
        randomUUID(),
        storeId,
        await hash(password, { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      ],
    );
    const operatorLogin = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mobile/login',
      payload: { cnpj: taxId, username: 'edge-operator', password },
    });
    expect(operatorLogin.statusCode, operatorLogin.body).toBe(200);
    operatorToken = operatorLogin.json().accessToken;
    const connection = await ctx.integration.createConnection(
      actor,
      randomUUID(),
      'ERP regressões',
    );
    integrationActor = {
      storeId,
      connectionId: connection.id,
      scopes: ['movements:write', 'batches:read'],
    };
    apiKey = (await ctx.integration.createKey(actor, connection.id, integrationActor.scopes)).key;
  });
  afterAll(async () => {
    vi.restoreAllMocks();
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
        'password_reset_tokens',
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
    await db?.close();
  });
  it('rejeita autocancelamento, cancelamento de VOID e referência de outro produto sem envenenar o replay', async () => {
    const p = await product(),
      other = await product(),
      saleId = randomUUID(),
      otherSaleId = randomUUID(),
      validVoidId = randomUUID();
    await importEvents([
      {
        externalEventId: saleId,
        externalProductId: p.externalProductId,
        type: 'SALE',
        quantity: 1,
        occurredAt: await now(),
      },
      {
        externalEventId: otherSaleId,
        externalProductId: other.externalProductId,
        type: 'SALE',
        quantity: 1,
        occurredAt: await now(),
      },
    ]);
    await importEvents([
      {
        externalEventId: validVoidId,
        externalProductId: p.externalProductId,
        type: 'VOID_MOVEMENT',
        originalExternalEventId: saleId,
        occurredAt: await now(),
      },
    ]);
    const selfId = randomUUID(),
      nestedId = randomUUID(),
      crossId = randomUUID();
    const batch = await importEvents([
      {
        externalEventId: selfId,
        externalProductId: p.externalProductId,
        type: 'VOID_MOVEMENT',
        originalExternalEventId: selfId,
        occurredAt: await now(),
      },
      {
        externalEventId: nestedId,
        externalProductId: p.externalProductId,
        type: 'VOID_MOVEMENT',
        originalExternalEventId: validVoidId,
        occurredAt: await now(),
      },
      {
        externalEventId: crossId,
        externalProductId: p.externalProductId,
        type: 'VOID_MOVEMENT',
        originalExternalEventId: otherSaleId,
        occurredAt: await now(),
      },
    ]);
    for (const id of [selfId, nestedId, crossId]) {
      expect(await status(id)).toMatchObject({ status: 'INVALID_VOID_REFERENCE' });
      expect(await fact(id)).toBeUndefined();
    }
    expect(await ctx.integration.batch(integrationActor, batch.id)).toMatchObject({
      status: 'COMPLETED_WITH_ISSUES',
    });
    const detail = await ctx.inventory.receive(actor, randomUUID(), {
      productId: p.id,
      quantity: 1,
      expiresOn: expiry,
    });
    expect(detail.totalQuantity).toBe(11);
    expect((await ctx.inventory.detail(storeId, other.id)).totalQuantity).toBe(9);
  });
  it('valida original conhecido apenas na inbox e não transforma uma cadeia de VOID em fatos', async () => {
    const p = await product(),
      first = randomUUID(),
      second = randomUUID();
    const batch = await ctx.integration.ingest(integrationActor, 'MOVEMENTS', {
      externalBatchId: randomUUID(),
      events: [
        {
          externalEventId: first,
          externalProductId: p.externalProductId,
          type: 'VOID_MOVEMENT',
          originalExternalEventId: second,
          occurredAt: await now(),
        },
        {
          externalEventId: second,
          externalProductId: p.externalProductId,
          type: 'VOID_MOVEMENT',
          originalExternalEventId: randomUUID(),
          occurredAt: await now(),
        },
      ],
    });
    await ctx.integration.process(storeId, batch.id);
    expect(await status(first)).toMatchObject({ status: 'INVALID_VOID_REFERENCE' });
    expect(await status(second)).toMatchObject({ status: 'PENDING_REFERENCE' });
    expect(await fact(first)).toBeUndefined();
    expect(await fact(second)).toBeUndefined();
    expect((await ctx.inventory.detail(storeId, p.id)).totalQuantity).toBe(10);
  });
  it('mantém cancelamento recebido antes do original na inbox e o recupera após o evento físico', async () => {
    const p = await product(),
      saleId = randomUUID(),
      voidId = randomUUID(),
      saleAt = await now();
    const batch = await importEvents([
      {
        externalEventId: voidId,
        externalProductId: p.externalProductId,
        type: 'VOID_MOVEMENT',
        originalExternalEventId: saleId,
        occurredAt: await now(),
      },
    ]);
    expect(await status(voidId)).toMatchObject({ status: 'PENDING_REFERENCE' });
    expect(await fact(voidId)).toBeUndefined();
    const queueCount = async () =>
      Number(
        (
          await admin.query<{ count: string }>(
            "SELECT count(*) FROM pgboss.job WHERE name='import.process' AND data->>'storeId'=$1 AND data->>'batchId'=$2",
            [storeId, batch.id],
          )
        ).rows[0]!.count,
      );
    const before = await queueCount();
    // Sem o original, a varredura não tem o que avançar: não reenfileira o lote.
    await ctx.integration.recover(storeId);
    expect(await queueCount()).toBe(before);
    await importEvents([
      {
        externalEventId: saleId,
        externalProductId: p.externalProductId,
        type: 'SALE',
        quantity: 4,
        occurredAt: saleAt,
      },
    ]);
    expect((await ctx.inventory.detail(storeId, p.id)).totalQuantity).toBe(6);
    // Com o original aceito, a varredura reenfileira o lote do cancelamento uma vez.
    await ctx.integration.recover(storeId);
    expect(await queueCount()).toBe(before + 1);
    await ctx.integration.process(storeId, batch.id);
    expect(await status(voidId)).toMatchObject({ status: 'ACCEPTED' });
    expect(await fact(voidId)).toBeDefined();
    expect(await ctx.integration.batch(integrationActor, batch.id)).toMatchObject({
      status: 'COMPLETED',
      errors: [],
    });
    expect((await ctx.inventory.detail(storeId, p.id)).totalQuantity).toBe(10);
  });
  it('aceita original e cancelamento no mesmo lote independentemente da ordem dos identificadores', async () => {
    const p = await product(),
      saleId = `z-${randomUUID()}`,
      voidId = `a-${randomUUID()}`,
      occurredAt = await now();
    const batch = await importEvents([
      {
        externalEventId: voidId,
        externalProductId: p.externalProductId,
        type: 'VOID_MOVEMENT',
        originalExternalEventId: saleId,
        occurredAt,
      },
      {
        externalEventId: saleId,
        externalProductId: p.externalProductId,
        type: 'SALE',
        quantity: 3,
        occurredAt,
      },
    ]);
    expect(await ctx.integration.batch(integrationActor, batch.id)).toMatchObject({
      status: 'COMPLETED',
    });
    expect((await ctx.inventory.detail(storeId, p.id)).totalQuantity).toBe(10);
  });
  it('normaliza validade e identificação nulas aceitas pelos DTOs antes de gravar movimentos e classificações', async () => {
    const p = await product(),
      scrapId = randomUUID(),
      returnId = randomUUID();
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/movement-batches',
      headers: { authorization: `Bearer ${apiKey}` },
      payload: {
        externalBatchId: randomUUID(),
        events: [
          {
            externalEventId: scrapId,
            externalProductId: p.externalProductId,
            type: 'SCRAP',
            quantity: 2,
            occurredAt: await now(),
            stockRecordId: null,
            expiresOn: null,
            lotCode: null,
          },
          {
            externalEventId: returnId,
            externalProductId: p.externalProductId,
            type: 'RETURN_RECEIPT',
            quantity: 1,
            occurredAt: await now(),
            expiresOn: null,
          },
        ],
      },
    });
    expect(response.statusCode, response.body).toBe(202);
    await ctx.integration.process(storeId, response.json().id);
    expect((await fact(scrapId))!.payload.identification).toEqual({});
    expect((await fact(returnId))!.payload).not.toHaveProperty('expiresOn');
    const issues = (
      await admin.query<{ id: string; detail: { movementId: string } }>(
        "SELECT id,detail FROM reconciliation_issues WHERE store_id=$1 AND product_id=$2 AND status='OPEN'",
        [storeId, p.id],
      )
    ).rows;
    expect(issues).toHaveLength(2);
    const issue = issues.find(
      (i) => i.detail.movementId === stableId(storeId, integrationActor.connectionId, scrapId),
    )!;
    const record = (await ctx.inventory.detail(storeId, p.id)).records[0]!;
    const resolved = await ctx.app.inject({
      method: 'POST',
      url: `/api/v1/reconciliation-issues/${issue.id}/resolve`,
      headers: { authorization: `Bearer ${accessToken}`, 'idempotency-key': randomUUID() },
      payload: {
        action: 'CLASSIFY',
        recordId: record.id,
        expiresOn: null,
        lotCode: null,
        reason: 'Classificação de descarte',
      },
    });
    expect(resolved.statusCode, resolved.body).toBe(201);
    const resolution = await one<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM movement_resolutions WHERE store_id=$1 AND movement_id=$2',
      [storeId, issue.detail.movementId],
    );
    expect(resolution!.payload).not.toHaveProperty('expiresOn');
    expect((await ctx.inventory.detail(storeId, p.id)).totalQuantity).toBe(8);
  });
  it('incrementa versões sob lock e rejeita classificação concorrente quando a pendência já foi resolvida', async () => {
    const p = await product(),
      eventId = randomUUID();
    await importEvents([
      {
        externalEventId: eventId,
        externalProductId: p.externalProductId,
        type: 'SCRAP',
        quantity: 1,
        occurredAt: await now(),
      },
    ]);
    const issue = await pending(p.id);
    await Promise.all(
      ['ERRADO-A', 'ERRADO-B'].map((lotCode) =>
        ctx.inventory.resolve(actor, randomUUID(), issue.id, {
          action: 'CLASSIFY',
          lotCode,
          reason: 'Lote informado ainda não localizado',
        }),
      ),
    );
    const finalInput = {
      action: 'CLASSIFY',
      lotCode: 'LOTE-A',
      reason: 'Lote verificado fisicamente',
    };
    const results = await Promise.allSettled([
      ctx.inventory.resolve(actor, randomUUID(), issue.id, finalInput),
      ctx.inventory.resolve(actor, randomUUID(), issue.id, finalInput),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      status: 'rejected',
      reason: { code: 'ISSUE_ALREADY_RESOLVED', status: 409 },
    });
    const versions = (
      await admin.query<{ version: number }>(
        "SELECT (payload->>'version')::int AS version FROM movement_resolutions WHERE store_id=$1 AND product_id=$2 ORDER BY version",
        [storeId, p.id],
      )
    ).rows;
    expect(versions.map((r) => r.version)).toEqual([1, 2, 3]);
    expect((await ctx.inventory.detail(storeId, p.id)).totalQuantity).toBe(9);
  });
  it('lê cabeçalho e registros da mesma revisão mesmo quando uma entrada confirma entre os SELECTs', async () => {
    const p = await product(),
      before = await ctx.inventory.detail(storeId, p.id),
      detailRecords = ctx.inventory.detailRecords.bind(ctx.inventory);
    let intercepted = false;
    // Entre o cabeçalho e os registros, outra transação confirma uma entrada.
    const spy = vi
      .spyOn(ctx.inventory, 'detailRecords')
      .mockImplementation(async (tx, store, id, epoch) => {
        if (!intercepted && id === p.id) {
          intercepted = true;
          await ctx.inventory.receive(actor, randomUUID(), {
            productId: p.id,
            quantity: 1,
            expiresOn: expiry,
          });
        }
        return detailRecords(tx, store, id, epoch);
      });
    try {
      const detail = await ctx.inventory.detail(storeId, p.id);
      expect(intercepted).toBe(true);
      expect(detail).toEqual(before);
    } finally {
      spy.mockRestore();
    }
    const after = await ctx.inventory.detail(storeId, p.id);
    expect(after.totalQuantity).toBe(11);
    expect(after.projectionRevision).toBeGreaterThan(before.projectionRevision);
  });
  it('lê versão e linhas de contagem no mesmo snapshot durante edição concorrente', async () => {
    const p = await product();
    const session = await ctx.inventory.createCount(actor, randomUUID(), p.id);
    const countLines = ctx.inventory.countLines.bind(ctx.inventory);
    let intercepted = false;
    // Entre a sessão e as linhas, outra transação salva linhas novas.
    const spy = vi.spyOn(ctx.inventory, 'countLines').mockImplementation(async (tx, store, id) => {
      if (!intercepted && id === session.id) {
        intercepted = true;
        await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
          type: 'lines',
          expectedVersion: session.version,
          lines: [{ id: randomUUID(), quantity: 7, expiresOn: expiry }],
        });
      }
      return countLines(tx, store, id);
    });
    try {
      expect(await ctx.inventory.count(storeId, session.id)).toEqual(session);
    } finally {
      spy.mockRestore();
    }
    const after = await ctx.inventory.count(storeId, session.id);
    expect(after.version).toBe(session.version + 1);
    expect(after.lines).toHaveLength(1);
  });
  it('não conclui lote antes da projeção e desfaz fatos quando a reconstrução falha', async () => {
    const p = await product(),
      eventId = randomUUID();
    const batch = await ctx.integration.ingest(integrationActor, 'MOVEMENTS', {
      externalBatchId: randomUUID(),
      events: [
        {
          externalEventId: eventId,
          externalProductId: p.externalProductId,
          type: 'SALE',
          quantity: 2,
          occurredAt: await now(),
        },
      ],
    });
    const spy = vi
      .spyOn(ctx.inventory, 'rebuild')
      .mockRejectedValueOnce(new Error('projection-failure'));
    try {
      await expect(ctx.integration.process(storeId, batch.id)).rejects.toThrow(
        'projection-failure',
      );
    } finally {
      spy.mockRestore();
    }
    expect(await fact(eventId)).toBeUndefined();
    expect(await ctx.integration.batch(integrationActor, batch.id)).toMatchObject({
      status: 'PROCESSING',
      completedAt: null,
    });
    await ctx.integration.process(storeId, batch.id);
    expect(await ctx.integration.batch(integrationActor, batch.id)).toMatchObject({
      status: 'COMPLETED',
    });
    expect(await ctx.inventory.detail(storeId, p.id)).toMatchObject({
      totalQuantity: 8,
      stale: false,
    });
  });
  it('filtra contagens por produto no HTTP e não aceita cursor pertencente a outro produto', async () => {
    const p = await product(),
      other = await product();
    const draft = await ctx.inventory.createCount(actor, randomUUID(), p.id);
    const otherDraft = await ctx.inventory.createCount(actor, randomUUID(), other.id);
    const get = (query: string) =>
      ctx.app.inject({
        method: 'GET',
        url: `/api/v1/count-sessions?${query}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
    const response = await get(`productId=${p.id}&limit=1`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items).toHaveLength(1);
    expect(response.json().items[0]).toMatchObject({
      id: draft.id,
      productId: p.id,
      status: 'COUNTING',
    });
    const second = await get(`productId=${p.id}&limit=1&cursor=${response.json().nextCursor}`);
    expect(second.json().items).toHaveLength(1);
    expect(second.json().items[0]).toMatchObject({ productId: p.id, status: 'CONFIRMED' });
    expect(second.json().nextCursor).toBeNull();
    expect((await get(`productId=${p.id}&cursor=${otherDraft.id}`)).json()).toEqual({
      items: [],
      nextCursor: null,
    });
    expect((await get('productId=not-a-uuid')).statusCode).toBe(400);
    expect((await get(`productId=${randomUUID()}`)).json()).toEqual({
      items: [],
      nextCursor: null,
    });
  });
  it('pagina histórico com desempate por ID sem pular, repetir ou misturar movimentos de outro produto', async () => {
    const p = await product(),
      other = await product(),
      occurredAt = await now();
    const events = Array.from({ length: 7 }, () => ({
      externalEventId: randomUUID(),
      externalProductId: p.externalProductId,
      type: 'SALE' as const,
      quantity: 1,
      occurredAt,
    }));
    const unrelated = {
      externalEventId: randomUUID(),
      externalProductId: other.externalProductId,
      type: 'SALE' as const,
      quantity: 1,
      occurredAt,
    };
    await importEvents([...events, unrelated]);
    const get = (query: string, productId = p.id) =>
      ctx.app.inject({
        method: 'GET',
        url: `/api/v1/inventory/products/${productId}/history?${query}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
    const response = await get('limit=2');
    expect(response.statusCode, response.body).toBe(200);
    const collected: string[] = response.json().items.map((item: { id: string }) => item.id);
    let cursor: string | null = response.json().nextCursor;
    await importEvents([
      {
        externalEventId: randomUUID(),
        externalProductId: p.externalProductId,
        type: 'SALE',
        quantity: 1,
        occurredAt: await now(),
      },
    ]);
    while (cursor) {
      const next = await get(`limit=2&cursor=${cursor}`);
      expect(next.statusCode, next.body).toBe(200);
      collected.push(...next.json().items.map((item: { id: string }) => item.id));
      cursor = next.json().nextCursor;
    }
    expect(collected).toEqual(
      events
        .map((event) => stableId(storeId, integrationActor.connectionId, event.externalEventId))
        .sort()
        .reverse(),
    );
    expect(new Set(collected).size).toBe(7);
    expect(
      (
        await get(
          `cursor=${stableId(storeId, integrationActor.connectionId, unrelated.externalEventId)}`,
        )
      ).json(),
    ).toEqual({ items: [], nextCursor: null });
    expect((await get('cursor=not-a-uuid')).statusCode).toBe(400);
    expect((await get('limit=101')).statusCode).toBe(400);
    expect((await get('', randomUUID())).statusCode).toBe(404);
  });
  it('operador abre, salva e confirma a contagem sozinho; abrir já inicia a sessão', async () => {
    const p = await product();
    const call = (method: 'POST' | 'PUT', url: string, payload: unknown) =>
      ctx.app.inject({
        method,
        url: `/api/v1${url}`,
        headers: { authorization: `Bearer ${operatorToken}`, 'idempotency-key': randomUUID() },
        payload: payload as Record<string, unknown>,
      });
    const created = await call('POST', '/count-sessions', { productId: p.id });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ status: 'COUNTING' });
    expect(created.json().startedAt).not.toBeNull();
    const saved = await call('PUT', `/count-sessions/${created.json().id}/lines`, {
      expectedVersion: created.json().version,
      lines: [{ id: randomUUID(), expiresOn: expiry, quantity: 6 }],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const confirmed = await call('POST', `/count-sessions/${created.json().id}/confirm`, {
      expectedVersion: saved.json().version,
      completeConfirmed: true,
    });
    expect(confirmed.statusCode, confirmed.body).toBe(201);
    expect(confirmed.json()).toMatchObject({ status: 'CONFIRMED' });
    expect(await ctx.inventory.detail(storeId, p.id)).toMatchObject({
      totalQuantity: 6,
      countWindowQuantity: 0,
    });
  });
  it('cobre venda durante a contagem como aviso e desconta venda após a última linha salva', async () => {
    const p = await product();
    let session = await ctx.inventory.createCount(actor, randomUUID(), p.id);
    await importEvents([
      {
        externalEventId: `durante-${p.id}`,
        externalProductId: p.externalProductId,
        type: 'SALE',
        quantity: 2,
        occurredAt: await now(),
      },
    ]);
    session = await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
      type: 'lines',
      expectedVersion: session.version,
      lines: [{ id: randomUUID(), expiresOn: expiry, quantity: 7 }],
    });
    // Venda depois da última linha salva e antes da confirmação: sai do saldo contado.
    await importEvents([
      {
        externalEventId: `depois-${p.id}`,
        externalProductId: p.externalProductId,
        type: 'SALE',
        quantity: 3,
        occurredAt: await now(),
      },
    ]);
    await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
      type: 'confirm',
      expectedVersion: session.version,
      completeConfirmed: true,
    });
    expect(await ctx.inventory.detail(storeId, p.id)).toMatchObject({
      totalQuantity: 4,
      countWindowQuantity: 2,
      stale: false,
    });
    const open = (
      await admin.query(
        "SELECT code FROM reconciliation_issues WHERE store_id=$1 AND product_id=$2 AND status='OPEN'",
        [storeId, p.id],
      )
    ).rows;
    expect(open).toEqual([]);
  });
  it('lista validades com saldo, da mais próxima à mais distante, com nível de risco', async () => {
    const p = await product();
    const soon = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const later = new Date(Date.now() + 60 * 86_400_000).toISOString().slice(0, 10);
    let session = await ctx.inventory.createCount(actor, randomUUID(), p.id);
    session = await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
      type: 'lines',
      expectedVersion: session.version,
      lines: [
        { id: randomUUID(), expiresOn: later, quantity: 5 },
        { id: randomUUID(), expiresOn: soon, lotCode: 'L-SOON', quantity: 2 },
      ],
    });
    await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
      type: 'confirm',
      expectedVersion: session.version,
      completeConfirmed: true,
    });
    type Expiry = { productId: string; expiresOn: string; levelName: string; quantity: number };
    const fetchPage = (after: string | null) =>
      ctx.app.inject({
        method: 'GET',
        url: `/api/v1/inventory/expiries?limit=2${after ? `&cursor=${after}` : ''}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
    const all: Expiry[] = [];
    let cursor: string | null = null;
    do {
      const response = await fetchPage(cursor);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { items: Expiry[]; nextCursor: string | null };
      all.push(...body.items);
      cursor = body.nextCursor;
    } while (cursor);
    const mine = all.filter((item) => item.productId === p.id);
    expect(mine.map((item) => [item.expiresOn, item.levelName, item.quantity])).toEqual([
      [soon, 'Urgente', 2],
      [later, 'Em dia', 5],
    ]);
    expect(all.map((item) => item.expiresOn)).toEqual(all.map((item) => item.expiresOn).sort());
    // Venda que esgota a validade mais próxima tira o registro da lista.
    await importEvents([
      {
        externalEventId: `esgota-${p.id}`,
        externalProductId: p.externalProductId,
        type: 'SALE',
        quantity: 2,
        occurredAt: await now(),
      },
    ]);
    const after = await ctx.inventory.expiries(storeId, { limit: 100 });
    expect(
      after.items.filter((item) => item.productId === p.id).map((item) => item.expiresOn),
    ).toEqual([later]);
  });
  it('separa as validades por faixa, pagina dentro da faixa e conta lotes e unidades de cada uma', async () => {
    type Summary = {
      items: { levelId: string | null; name: string; lots: number; units: number }[];
    };
    const get = (url: string) =>
      ctx.app.inject({
        method: 'GET',
        url: `/api/v1${url}`,
        headers: { authorization: `Bearer ${accessToken}` },
      });
    const before = (await get('/inventory/expiries/summary')).json() as Summary;
    // Níveis padrão da loja: os de antes da reunião de 16/10/2026.
    expect(before.items.map((item) => item.name)).toEqual([
      'Vencido',
      'Urgente',
      'Atenção',
      'Em dia',
    ]);
    const ids = Object.fromEntries(before.items.map((item) => [item.name, item.levelId!]));
    const p = await product();
    const day = (days: number) =>
      new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    // Prazos padrão da loja: urgente até 5 dias, atenção até 15.
    const lines = [
      { expiresOn: day(-3), quantity: 1 },
      { expiresOn: day(1), quantity: 2 },
      { expiresOn: day(3), quantity: 3 },
      { expiresOn: day(10), quantity: 4 },
      { expiresOn: day(40), quantity: 5 },
    ];
    let session = await ctx.inventory.createCount(actor, randomUUID(), p.id);
    session = await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
      type: 'lines',
      expectedVersion: session.version,
      lines: lines.map((line) => ({ id: randomUUID(), ...line })),
    });
    await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
      type: 'confirm',
      expectedVersion: session.version,
      completeConfirmed: true,
    });
    type Expiry = { productId: string; expiresOn: string; levelId: string; quantity: number };
    const band = async (name: string) => {
      const level = ids[name]!;
      const items: Expiry[] = [];
      let cursor: string | null = null;
      do {
        // Um por página: o cursor precisa andar só dentro da faixa.
        const response = await get(
          `/inventory/expiries?levelId=${level}&limit=1${cursor ? `&cursor=${cursor}` : ''}`,
        );
        expect(response.statusCode, response.body).toBe(200);
        const body = response.json() as { items: Expiry[]; nextCursor: string | null };
        expect(body.items.every((item) => item.levelId === level)).toBe(true);
        items.push(...body.items);
        cursor = body.nextCursor;
      } while (cursor);
      return items.filter((item) => item.productId === p.id).map((item) => item.quantity);
    };
    expect(await band('Vencido')).toEqual([1]);
    expect(await band('Urgente')).toEqual([2, 3]);
    expect(await band('Atenção')).toEqual([4]);
    expect(await band('Em dia')).toEqual([5]);
    const summary = (await get('/inventory/expiries/summary')).json() as Summary;
    const delta = summary.items.map((item, index) => [
      item.name,
      item.lots - before.items[index]!.lots,
      item.units - before.items[index]!.units,
    ]);
    expect(delta).toEqual([
      ['Vencido', 1, 1],
      ['Urgente', 2, 5],
      ['Atenção', 1, 4],
      ['Em dia', 1, 5],
    ]);
    expect((await get('/inventory/expiries?levelId=VENCIDO')).statusCode).toBe(400);
    // NV01: retirar um nível preenche sua faixa com o seguinte, sem lacuna interna.
    const levels = (await get('/store/expiry-levels')).json() as {
      version: number;
      items: { name: string }[];
    };
    const removed = await ctx.app.inject({
      method: 'PUT',
      url: '/api/v1/store/expiry-levels',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': randomUUID(),
        'content-type': 'application/json',
      },
      payload: JSON.stringify({
        expectedVersion: levels.version,
        levels: levels.items.filter((item) => item.name !== 'Atenção'),
      }),
    });
    expect(removed.statusCode, removed.body).toBe(200);
    const none = await get('/inventory/expiries?levelId=NONE&limit=100');
    expect(
      (none.json() as { items: Expiry[] }).items
        .filter((item) => item.productId === p.id)
        .map((item) => item.quantity),
    ).toEqual([]);
    expect(await band('Em dia')).toEqual([4, 5]);
    const covered = (await get('/inventory/expiries/summary')).json() as Summary;
    expect(covered.items.some((item) => item.levelId === null)).toBe(false);
  });
  it('separa pelo microssegundo a venda coberta pela contagem da venda posterior ao corte', async () => {
    // Um corte cujos microssegundos não cabem num Date: se algum caminho o lesse com
    // milissegundos, o corte recuaria e a venda do próprio instante sairia do saldo.
    const p = await product();
    let session = await ctx.inventory.createCount(actor, randomUUID(), p.id);
    session = await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
      type: 'lines',
      expectedVersion: session.version,
      lines: [{ id: randomUUID(), expiresOn: expiry, quantity: 20 }],
    });
    const started = '2026-01-01T00:00:00.000001Z',
      cutoff = '2026-01-01T00:00:00.123456Z',
      afterCutoff = '2026-01-01T00:00:00.123457Z';
    await admin.query(
      'UPDATE count_sessions SET started_at=$3, lines_saved_at=$4 WHERE store_id=$1 AND id=$2',
      [storeId, session.id, started, cutoff],
    );
    await admin.query('UPDATE count_lines SET created_at=$3 WHERE store_id=$1 AND session_id=$2', [
      storeId,
      session.id,
      started,
    ]);
    const confirmed = await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
      type: 'confirm',
      expectedVersion: session.version,
      completeConfirmed: true,
    });
    expect(confirmed).toMatchObject({ startedAt: started, cutoffAt: cutoff });
    await importEvents([
      {
        externalEventId: `no-corte-${p.id}`,
        externalProductId: p.externalProductId,
        type: 'SALE',
        quantity: 2,
        occurredAt: cutoff,
      },
      {
        externalEventId: `apos-corte-${p.id}`,
        externalProductId: p.externalProductId,
        type: 'SALE',
        quantity: 3,
        occurredAt: afterCutoff,
      },
    ]);
    expect(await ctx.inventory.detail(storeId, p.id)).toMatchObject({
      lastCountAt: cutoff,
      totalQuantity: 17,
      countWindowQuantity: 2,
      stale: false,
    });
  });

  it('catálogo: código que mudou de produto vai para o novo dono em qualquer ordem do lote', async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const [moved, kept] = [`789${Date.now()}1`, `789${Date.now()}2`];
    const importCatalog = async (
      products: { id: string; description: string; barcodes: string[] }[],
    ) => {
      const batch = await ctx.integration.ingest(integrationActor, 'CATALOG', {
        externalBatchId: randomUUID(),
        products: products.map((p) => ({
          externalProductId: p.id,
          description: p.description,
          barcodes: p.barcodes,
        })),
      });
      await ctx.integration.process(storeId, batch.id);
      return one<{ status: string; errors: unknown[] }>(
        'SELECT status, errors FROM import_batches WHERE store_id=$1 AND id=$2',
        [storeId, batch.id],
      );
    };
    const owner = async (barcode: string) =>
      (
        await one<{ external_product_id: string }>(
          'SELECT p.external_product_id FROM product_barcodes b JOIN products p ON p.store_id=b.store_id AND p.id=b.product_id WHERE b.store_id=$1 AND b.barcode=$2',
          [storeId, barcode],
        )
      )?.external_product_id;
    expect(
      await importCatalog([
        { id: a, description: 'Iogurte A', barcodes: [moved] },
        { id: b, description: 'Iogurte B', barcodes: [kept] },
      ]),
    ).toMatchObject({ status: 'COMPLETED' });
    // O ERP passou o código de A para B; no lote, B vem antes de A.
    expect(
      await importCatalog([
        { id: b, description: 'Iogurte B 170g', barcodes: [kept, moved] },
        { id: a, description: 'Iogurte A', barcodes: [] },
      ]),
    ).toMatchObject({ status: 'COMPLETED', errors: [] });
    expect(await owner(moved)).toBe(b);
    expect(await owner(kept)).toBe(b);

    // Outra conexão com o mesmo código: conflito só desse código; o resto do produto grava.
    const other = await ctx.integration.createConnection(actor, randomUUID(), 'Outro ERP');
    const c = randomUUID();
    const result = await ctx.integration.ingest(
      { storeId, connectionId: other.id, scopes: ['catalog:write'] },
      'CATALOG',
      {
        externalBatchId: randomUUID(),
        products: [
          { externalProductId: c, description: 'Iogurte C', barcodes: [moved, `${moved}9`] },
        ],
      },
    );
    await ctx.integration.process(storeId, result.id);
    expect(
      await one('SELECT status, errors FROM import_batches WHERE store_id=$1 AND id=$2', [
        storeId,
        result.id,
      ]),
    ).toMatchObject({
      status: 'COMPLETED_WITH_ISSUES',
      errors: [{ externalId: c, code: 'CATALOG_CONFLICT' }],
    });
    expect(await owner(moved)).toBe(b);
    expect(await owner(`${moved}9`)).toBe(c);
  });

  it('um produto com falha na importação não segura a baixa dos outros', async () => {
    const [failing, other] = (await Promise.all([product(), product()])).sort((x, y) =>
      x.externalProductId.localeCompare(y.externalProductId),
    );
    const at = await now();
    const events = [failing!, other!].map((item) => ({
      externalEventId: randomUUID(),
      externalProductId: item.externalProductId,
      type: 'SALE' as const,
      quantity: 1,
      occurredAt: at,
    }));
    const batch = await ctx.integration.ingest(integrationActor, 'MOVEMENTS', {
      externalBatchId: randomUUID(),
      events,
    });
    // Os produtos seguem a ordem dos códigos do ERP: o primeiro falha ao reconstruir.
    const spy = vi
      .spyOn(ctx.inventory, 'rebuildIfStale')
      .mockRejectedValueOnce(new Error('falha de teste'));
    await expect(ctx.integration.process(storeId, batch.id)).rejects.toThrow('falha de teste');
    spy.mockRestore();
    expect(await status(events[0]!.externalEventId)).toMatchObject({ status: 'RECEIVED' });
    expect(await status(events[1]!.externalEventId)).toMatchObject({ status: 'ACCEPTED' });
    expect((await ctx.inventory.detail(storeId, other!.id)).totalQuantity).toBe(9);
    expect(
      await one('SELECT status FROM import_batches WHERE store_id=$1 AND id=$2', [
        storeId,
        batch.id,
      ]),
    ).toMatchObject({ status: 'PROCESSING' });
    // A nova tentativa conclui o que faltou, sem baixar de novo o que já tinha baixado.
    await ctx.integration.process(storeId, batch.id);
    expect(await status(events[0]!.externalEventId)).toMatchObject({ status: 'ACCEPTED' });
    expect((await ctx.inventory.detail(storeId, failing!.id)).totalQuantity).toBe(9);
    expect((await ctx.inventory.detail(storeId, other!.id)).totalQuantity).toBe(9);
  });

  it('aviso de lote esgotado pela venda vale por dois dias e sai sozinho', async () => {
    const item = await product();
    const sale = randomUUID();
    await importEvents([
      {
        externalEventId: sale,
        externalProductId: item.externalProductId,
        type: 'SALE',
        quantity: 10,
        occurredAt: await now(),
      },
    ]);
    await ctx.notifications.evaluate(storeId, item.id);
    const depleted = () =>
      one<{ active: boolean }>(
        "SELECT active FROM notifications WHERE store_id=$1 AND product_id=$2 AND type='DEPLETED'",
        [storeId, item.id],
      );
    expect(await depleted()).toMatchObject({ active: true });
    // Três dias depois da venda que zerou o lote: o pedido de conferência já passou.
    await admin.query(
      "UPDATE stock_movements SET occurred_at = occurred_at - interval '3 days' WHERE store_id=$1 AND id=$2",
      [storeId, stableId(storeId, integrationActor.connectionId, sale)],
    );
    await ctx.notifications.evaluate(storeId, item.id);
    expect(await depleted()).toMatchObject({ active: false });
  });
});
