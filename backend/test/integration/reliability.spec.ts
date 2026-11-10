import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/bootstrap/app.js';
import { Jobs } from '../../src/shared/infrastructure/jobs.js';
import {
  stableId,
  type IntegrationActor,
  type MovementInput,
} from '../../src/modules/integration/adapters/out/prisma-integration.js';
import type { TenantActor } from '../../src/shared/domain/context.js';
import { testCnpj } from '../support/cnpj.js';

/**
 * Trabalho periódico do worker: recuperação de lotes, avaliação de alertas e limpeza.
 * Cada teste reproduz uma falha encontrada na revisão de confiabilidade.
 */
describe('Trabalho periódico sem desperdício nem bloqueio', () => {
  const storeId = randomUUID();
  const actor: TenantActor = {
    storeId,
    userId: randomUUID(),
    role: 'OWNER',
    sessionId: randomUUID(),
    restricted: false,
  };
  let admin: Pool, jobs: Jobs, ctx: Awaited<ReturnType<typeof createApp>>;
  let erp: IntegrationActor;

  const count = async (sql: string, values: unknown[]) =>
    Number((await admin.query<{ n: string }>(sql, values)).rows[0]!.n);
  const runs = (productId: string) =>
    count('SELECT count(*) n FROM projection_runs WHERE store_id=$1 AND product_id=$2', [
      storeId,
      productId,
    ]);
  const queued = (batchId: string) =>
    count("SELECT count(*) n FROM pgboss.job WHERE name='import.process' AND data->>'batchId'=$1", [
      batchId,
    ]);
  const status = async (externalEventId: string) =>
    (
      await admin.query<{ status: string }>(
        'SELECT status FROM integration_events WHERE store_id=$1 AND connection_id=$2 AND external_event_id=$3',
        [storeId, erp.connectionId, externalEventId],
      )
    ).rows[0]?.status;
  async function now() {
    return (
      await admin.query<{ t: string }>(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') t`,
      )
    ).rows[0]!.t;
  }
  /** Produto do catálogo com uma contagem confirmada de 50 unidades. */
  async function trackedProduct(expiresOn = '2099-01-01') {
    const externalProductId = randomUUID();
    const id = stableId(storeId, erp.connectionId, externalProductId, 'product');
    await catalog(externalProductId);
    let session = await ctx.inventory.createCount(actor, randomUUID(), id);
    session = await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
      type: 'lines',
      expectedVersion: session.version,
      lines: [{ id: randomUUID(), expiresOn, quantity: 50 }],
    });
    await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
      type: 'confirm',
      expectedVersion: session.version,
      completeConfirmed: true,
    });
    return { id, externalProductId };
  }
  function catalog(externalProductId: string) {
    return ctx.prisma.tenant(storeId, (tx) =>
      ctx.integration.upsertProduct(tx, storeId, erp.connectionId, {
        externalProductId,
        description: `Produto ${externalProductId}`,
        barcodes: [externalProductId],
      }),
    );
  }
  async function importEvents(events: MovementInput[]) {
    const batch = await ctx.integration.ingest(erp, 'MOVEMENTS', {
      externalBatchId: randomUUID(),
      events,
    });
    await ctx.integration.process(storeId, batch.id);
    return batch;
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await admin.query(
      "INSERT INTO stores(id,cnpj_normalized,name) VALUES($1,$2,'Loja confiabilidade')",
      [storeId, testCnpj()],
    );
    await admin.query('INSERT INTO store_settings(store_id) VALUES($1)', [storeId]);
    await admin.query(
      "INSERT INTO store_users(id,store_id,username,username_normalized,password_hash,role,must_change_password) VALUES($1,$2,'dono','dono','x','OWNER',false)",
      [actor.userId, storeId],
    );
    jobs = new Jobs();
    await jobs.start();
    ctx = await createApp({ jobs, jwtSecret: 'reliability-test-secret-at-least-thirty-two-bytes' });
    const connection = await ctx.integration.createConnection(actor, randomUUID(), 'ERP');
    erp = { storeId, connectionId: connection.id, scopes: ['movements:write'] };
  }, 120000);

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

  it('reprocessar um lote sem fato novo não reconstrói o produto de novo', async () => {
    const product = await trackedProduct();
    const at = await now();
    // A quantidade fracionada deixa o lote COMPLETED_WITH_ISSUES: ele volta a ser
    // processado (reprocessamento manual ou recuperação), sem que nada tenha mudado.
    const batch = await importEvents([
      {
        externalEventId: randomUUID(),
        externalProductId: product.externalProductId,
        type: 'SALE',
        quantity: 1,
        occurredAt: at,
      },
      {
        externalEventId: randomUUID(),
        externalProductId: product.externalProductId,
        type: 'SALE',
        quantity: 0.5,
        occurredAt: at,
      },
    ]);
    const before = await runs(product.id);
    await ctx.integration.process(storeId, batch.id);
    await ctx.integration.process(storeId, batch.id);
    expect(await runs(product.id)).toBe(before);
    expect(await ctx.inventory.detail(storeId, product.id)).toMatchObject({
      totalQuantity: 49,
      stale: false,
    });
  });

  it('a varredura só reenfileira pendência de produto quando o produto chega', async () => {
    const known = await trackedProduct();
    const missing = randomUUID();
    const sale = randomUUID();
    const at = await now();
    const batch = await importEvents([
      {
        externalEventId: randomUUID(),
        externalProductId: known.externalProductId,
        type: 'SALE',
        quantity: 1,
        occurredAt: at,
      },
      {
        externalEventId: sale,
        externalProductId: missing,
        type: 'SALE',
        quantity: 2,
        occurredAt: at,
      },
    ]);
    expect(await status(sale)).toBe('PENDING_PRODUCT');
    const before = await queued(batch.id);
    const rebuilt = await runs(known.id);
    // Minutos seguidos com o produto ainda desconhecido: nada a fazer, nenhum job.
    await ctx.integration.recover(storeId);
    await ctx.integration.recover(storeId);
    expect(await queued(batch.id)).toBe(before);
    // O catálogo traz o produto: a próxima varredura reenfileira uma vez.
    await catalog(missing);
    await ctx.integration.recover(storeId);
    expect(await queued(batch.id)).toBe(before + 1);
    await ctx.integration.process(storeId, batch.id);
    expect(await status(sale)).toBe('ACCEPTED');
    // O produto que já estava certo não é reconstruído por causa do outro.
    expect(await runs(known.id)).toBe(rebuilt);
  });

  it('retoma lote parado cujo job esgotou as tentativas, sem acumular jobs', async () => {
    const product = await trackedProduct();
    const batch = await ctx.integration.ingest(erp, 'MOVEMENTS', {
      externalBatchId: randomUUID(),
      events: [
        {
          externalEventId: randomUUID(),
          externalProductId: product.externalProductId,
          type: 'SALE',
          quantity: 3,
          occurredAt: await now(),
        },
      ],
    });
    // O pg-boss desistiu do job (5 falhas em cerca de um minuto) e o lote ficou recebido.
    await admin.query(
      "UPDATE pgboss.job SET state='failed' WHERE name='import.process' AND data->>'batchId'=$1",
      [batch.id],
    );
    await admin.query(
      "UPDATE import_batches SET created_at = clock_timestamp() - interval '1 hour' WHERE id=$1",
      [batch.id],
    );
    const live = () =>
      count(
        "SELECT count(*) n FROM pgboss.job WHERE name='import.process' AND data->>'batchId'=$1 AND state IN ('created','retry','active')",
        [batch.id],
      );
    expect(await live()).toBe(0);
    await ctx.integration.recover(storeId);
    await ctx.integration.recover(storeId);
    // Um job de recuperação, não um por varredura.
    expect(await live()).toBe(1);
    await ctx.integration.process(storeId, batch.id);
    expect(await ctx.integration.batch(erp, batch.id)).toMatchObject({ status: 'COMPLETED' });
    expect((await ctx.inventory.detail(storeId, product.id)).totalQuantity).toBe(47);
  });

  it('a varredura dos alertas não espera produto travado e o job dele o avalia depois', async () => {
    // Vence em dois dias: nível Urgente, que avisa.
    const soon = (
      await admin.query<{ day: string }>(
        `SELECT to_char((clock_timestamp() AT TIME ZONE timezone)::date + 2, 'YYYY-MM-DD') AS day
           FROM stores WHERE id = $1`,
        [storeId],
      )
    ).rows[0]!.day;
    const busy = await trackedProduct(soon);
    const free = await trackedProduct(soon);
    const alerts = (productId: string) =>
      count(
        "SELECT count(*) n FROM notifications WHERE store_id=$1 AND product_id=$2 AND type='EXPIRY' AND active",
        [storeId, productId],
      );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let reached!: () => void;
    const inside = new Promise<void>((resolve) => (reached = resolve));
    // Uma entrada, uma contagem ou uma reconstrução segurando a trava do produto.
    const holder = ctx.prisma.tenant(storeId, async (tx) => {
      await ctx.inventory.lock(tx, storeId, busy.id);
      reached();
      await gate;
    });
    try {
      await inside;
      const started = Date.now();
      await ctx.notifications.evaluate(storeId);
      // Sem esperar a trava (lock_timeout de 5 s), e os outros produtos avaliados.
      expect(Date.now() - started).toBeLessThan(4000);
      expect(await alerts(free.id)).toBe(1);
      expect(await alerts(busy.id)).toBe(0);
    } finally {
      release();
      await holder;
    }
    await ctx.notifications.evaluate(storeId, busy.id);
    expect(await alerts(busy.id)).toBe(1);
  });

  it('a limpeza apaga só os refresh tokens vencidos há mais de 7 dias', async () => {
    const sessionId = randomUUID();
    await admin.query(
      "INSERT INTO auth_sessions(id,store_id,user_id,client,expires_at) VALUES($1,$2,$3,'mobile',clock_timestamp()+interval '1 day')",
      [sessionId, storeId, actor.userId],
    );
    const tokens = { old: randomUUID(), recent: randomUUID(), valid: randomUUID() };
    for (const [id, expires] of [
      [tokens.old, "clock_timestamp()-interval '8 days'"],
      [tokens.recent, "clock_timestamp()-interval '1 day'"],
      [tokens.valid, "clock_timestamp()+interval '1 day'"],
    ] as const)
      await admin.query(
        `INSERT INTO refresh_tokens(id,store_id,session_id,token_hash,expires_at) VALUES($1,$2,$3,$4,${expires})`,
        [id, storeId, sessionId, randomUUID()],
      );
    const { purgeExpiredRefreshTokens } =
      await import('../../src/modules/identity/adapters/out/prisma-identity.js');
    expect(await ctx.prisma.tenant(storeId, (tx) => purgeExpiredRefreshTokens(tx, storeId))).toBe(
      1,
    );
    const left = (
      await admin.query<{ id: string }>('SELECT id FROM refresh_tokens WHERE session_id=$1', [
        sessionId,
      ])
    ).rows.map((row) => row.id);
    expect(left.sort()).toEqual([tokens.recent, tokens.valid].sort());
  });
});
