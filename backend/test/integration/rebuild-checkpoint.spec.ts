import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/bootstrap/app.js';
import { Jobs } from '../../src/shared/infrastructure/jobs.js';
import {
  stableId,
  type IntegrationActor,
  type MovementInput,
} from '../../src/modules/integration/adapters/out/prisma-integration.js';
import { InventoryAudit } from '../../src/modules/inventory/adapters/out/inventory-audit.js';
import { PrismaStore } from '../../src/modules/tenancy/adapters/out/prisma-store.js';
import type { TenantActor } from '../../src/shared/domain/context.js';
import { testCnpj } from '../support/cnpj.js';

/**
 * Reconstrução retomada de um retrato (volume do piloto, 20/11/2026). Um produto contado há 20
 * dias, com vendas e entradas desde então: a primeira reconstrução é completa e guarda o retrato
 * de 8 dias atrás; as vendas seguintes refazem só o que veio depois dele. Venda atrasada para
 * antes do retrato volta à reconstrução completa. Em todos os passos, a conferência refaz tudo
 * do zero e compara lotes, baixas por lote e pendências com o gravado.
 */
describe('Reconstrução a partir do retrato', () => {
  const storeId = randomUUID();
  const actor: TenantActor = {
    storeId,
    userId: randomUUID(),
    role: 'OWNER',
    sessionId: randomUUID(),
    restricted: false,
  };
  let admin: Pool, jobs: Jobs, ctx: Awaited<ReturnType<typeof createApp>>;
  let erp: IntegrationActor, audit: InventoryAudit;
  const externalProductId = 'retrato';
  let productId: string;

  const instant = async (daysAgo: number, hour = 12) =>
    (
      await admin.query<{ t: string }>(
        `SELECT to_char((date_trunc('day', clock_timestamp()) - make_interval(days => $1)
                         + make_interval(hours => $2)) AT TIME ZONE 'UTC',
                        'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') t`,
        [daysAgo, hour],
      )
    ).rows[0]!.t;
  /** Fato antigo gravado direto, como se tivesse sido importado no dia. */
  async function pastFact(fact: Record<string, unknown> & { occurredAt: string }) {
    const id = randomUUID();
    const payload = { id, storeId, productId, ...fact };
    await admin.query(
      `INSERT INTO stock_movements(id, store_id, product_id, occurred_at, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [id, storeId, productId, fact.occurredAt, JSON.stringify(payload)],
    );
    await admin.query(
      'UPDATE product_inventory SET input_revision = input_revision + 1 WHERE store_id=$1 AND product_id=$2',
      [storeId, productId],
    );
    return id;
  }
  const pastSale = async (daysAgo: number, hour: number, quantity: number) =>
    pastFact({
      type: 'SALE',
      quantity,
      occurredAt: await instant(daysAgo, hour),
      source: { kind: 'ERP', connectionId: erp.connectionId, externalEventId: randomUUID() },
    });
  async function rebuild() {
    await ctx.prisma.tenant(storeId, (tx) => ctx.inventory.rebuildIfStale(tx, storeId, productId));
  }
  async function importEvents(events: MovementInput[]) {
    const batch = await ctx.integration.ingest(erp, 'MOVEMENTS', {
      externalBatchId: randomUUID(),
      events,
    });
    await ctx.integration.process(storeId, batch.id);
  }
  const lastMode = async () =>
    (
      await admin.query<{ mode: string }>(
        `SELECT summary->>'mode' AS mode FROM projection_runs
          WHERE store_id=$1 AND product_id=$2 ORDER BY revision DESC LIMIT 1`,
        [storeId, productId],
      )
    ).rows[0]!.mode;
  async function expectAuditClean() {
    const report = await audit.check(storeId);
    expect(report.pending).toEqual([]);
    expect(report.differences).toEqual([]);
  }
  const balance = async () => (await ctx.inventory.detail(storeId, productId)).totalQuantity;

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await admin.query("INSERT INTO stores(id,cnpj_normalized,name) VALUES($1,$2,'Loja retrato')", [
      storeId,
      testCnpj(),
    ]);
    await admin.query('INSERT INTO store_settings(store_id) VALUES($1)', [storeId]);
    await admin.query(
      "INSERT INTO store_users(id,store_id,username,username_normalized,password_hash,role,must_change_password) VALUES($1,$2,'dono','dono','x','OWNER',false)",
      [actor.userId, storeId],
    );
    jobs = new Jobs();
    await jobs.start();
    ctx = await createApp({ jobs, jwtSecret: 'checkpoint-test-secret-at-least-thirty-two-bytes' });
    audit = new InventoryAudit(ctx.prisma, ctx.inventory, new PrismaStore(ctx.prisma, jobs));
    const connection = await ctx.integration.createConnection(actor, randomUUID(), 'ERP');
    erp = { storeId, connectionId: connection.id, scopes: ['movements:write'] };
    productId = stableId(storeId, erp.connectionId, externalProductId, 'product');
    await ctx.prisma.tenant(storeId, (tx) =>
      ctx.integration.upsertProduct(tx, storeId, erp.connectionId, {
        externalProductId,
        description: 'Produto com histórico',
        barcodes: [],
      }),
    );
    // Contagem de 2 lotes, levada para 20 dias atrás.
    let session = await ctx.inventory.createCount(actor, randomUUID(), productId);
    session = await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
      type: 'lines',
      expectedVersion: session.version,
      lines: [
        { id: randomUUID(), expiresOn: '2099-01-10', quantity: 30, lotCode: 'A' },
        { id: randomUUID(), expiresOn: '2099-01-20', quantity: 40, lotCode: 'B' },
      ],
    });
    await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
      type: 'confirm',
      expectedVersion: session.version,
      completeConfirmed: true,
    });
    const back = 'make_interval(days => 20)';
    await admin.query(
      `UPDATE count_sessions SET started_at = started_at - ${back}, cutoff_at = cutoff_at - ${back}
        WHERE store_id=$1 AND product_id=$2`,
      [storeId, productId],
    );
    await admin.query(
      `UPDATE inventory_epochs SET cutoff_at = cutoff_at - ${back},
              count_started_at = count_started_at - ${back}
        WHERE store_id=$1 AND product_id=$2`,
      [storeId, productId],
    );
    await admin.query(
      `UPDATE stock_records SET available_at = available_at - ${back},
              allocation_priority_at = allocation_priority_at - ${back}
        WHERE store_id=$1 AND product_id=$2`,
      [storeId, productId],
    );
  }, 120000);

  afterAll(async () => {
    await ctx?.app.close();
    await jobs?.stop();
    if (admin) {
      await admin.query("DELETE FROM pgboss.job WHERE data->>'storeId'=$1", [storeId]);
      await admin.query('UPDATE product_inventory SET epoch_id=NULL WHERE store_id=$1', [storeId]);
      for (const table of [
        'notification_reads',
        'notifications',
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
        'product_sales_rates',
        'product_inventory',
        'product_barcodes',
        'products',
        'integration_keys',
        'integration_connections',
        'command_receipts',
        'audit_events',
        'refresh_tokens',
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

  it('a primeira reconstrução é completa e guarda o retrato de 8 dias atrás', async () => {
    // Vendas no mesmo instante desempatam pela chave; uma entrada no meio, com validade antes.
    for (const daysAgo of [18, 16, 14, 12, 10, 9])
      for (const quantity of [2, 3]) await pastSale(daysAgo, 15, quantity);
    await pastFact({
      type: 'APP_RECEIPT',
      quantity: 12,
      expiresOn: '2099-01-05',
      lotCode: 'E',
      stockRecordId: randomUUID(),
      actorId: actor.userId,
      occurredAt: await instant(13, 6),
      source: { kind: 'APP', commandId: randomUUID() },
    });
    await rebuild();
    expect(await lastMode()).toBe('FULL');
    expect(await balance()).toBe(30 + 40 + 12 - 30);
    const { rows } = await admin.query<{ at: string }>(
      `SELECT state->'position'->>'occurredAt' AS at FROM inventory_checkpoints
        WHERE store_id=$1 AND product_id=$2`,
      [storeId, productId],
    );
    expect(rows[0]!.at).toBe(await instant(9, 15));
    await expectAuditClean();
  });

  it('vendas novas retomam do retrato e dão os mesmos números', async () => {
    const now = await instant(0, 0);
    const events: MovementInput[] = [5, 4, 1].map((quantity) => ({
      externalEventId: randomUUID(),
      externalProductId,
      type: 'SALE',
      quantity,
      occurredAt: now,
    }));
    // E uma venda importada com 3 dias de atraso, depois do retrato.
    events.push({
      externalEventId: 'atrasada-3-dias',
      externalProductId,
      type: 'SALE',
      quantity: 6,
      occurredAt: await instant(3, 10),
    });
    await importEvents(events);
    expect(await lastMode()).toBe('RESUMED');
    expect(await balance()).toBe(52 - 16);
    await expectAuditClean();
    // Cancelamento de uma venda recente: também retoma.
    await importEvents([
      {
        externalEventId: 'cancela-atrasada',
        externalProductId,
        type: 'VOID_MOVEMENT',
        occurredAt: now,
        originalExternalEventId: 'atrasada-3-dias',
      },
    ]);
    expect(await lastMode()).toBe('RESUMED');
    expect(await balance()).toBe(52 - 10);
    await expectAuditClean();
  });

  it('venda atrasada para antes do retrato refaz tudo, e a seguinte volta a retomar', async () => {
    await importEvents([
      {
        externalEventId: 'atrasada-11-dias',
        externalProductId,
        type: 'SALE',
        quantity: 7,
        occurredAt: await instant(11, 9),
      },
    ]);
    expect(await lastMode()).toBe('FULL');
    expect(await balance()).toBe(42 - 7);
    await expectAuditClean();
    await importEvents([
      {
        externalEventId: randomUUID(),
        externalProductId,
        type: 'SALE',
        quantity: 1,
        occurredAt: await instant(0, 0),
      },
    ]);
    expect(await lastMode()).toBe('RESUMED');
    expect(await balance()).toBe(34);
    await expectAuditClean();
  });
});
