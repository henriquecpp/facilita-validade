import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../backend/dist/bootstrap/app.js';
import { Database } from '../backend/dist/shared/infrastructure/database.js';
import { Jobs } from '../backend/dist/shared/infrastructure/jobs.js';
import { stableId } from '../backend/dist/modules/integration/adapters/out/prisma-integration.js';

// A disposable database prevents the existing worker from consuming these jobs.
if (!['development', 'test'].includes(process.env.NODE_ENV)) {
  throw new Error('O ensaio exige NODE_ENV=development/test e PostgreSQL local migrado.');
}
const require = createRequire(new URL('../backend/package.json', import.meta.url));
const { Pool } = require('pg');
const adminUrl = new URL(process.env.MIGRATION_DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname)) {
  throw new Error('O ensaio só cria bancos temporários em PostgreSQL local.');
}
const databaseName = `estoque_load_${randomUUID().replaceAll('-', '')}`;
function connection(value) {
  const url = new URL(value);
  assert.equal(
    url.hostname,
    adminUrl.hostname,
    'As conexões precisam apontar ao mesmo servidor local.',
  );
  assert.equal(url.port, adminUrl.port);
  url.pathname = `/${databaseName}`;
  return url.toString();
}
const migrationUrl = connection(adminUrl);
const runtimeUrl = connection(process.env.DATABASE_URL);
const authUrl = connection(process.env.AUTH_DATABASE_URL);
const control = new Pool({ connectionString: adminUrl.toString(), max: 1 });
let admin,
  context,
  database,
  jobs,
  created = false,
  sampling = false,
  timer;
const samples = { count: 0, maxWaitingForLock: 0, maxActiveConnections: 0 };
const elapsed = (start) => Math.round((performance.now() - start) * 100) / 100;
try {
  await control.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  // Production mode skips the development ALTER ROLE passwords on this shared server.
  const migration = spawnSync(process.execPath, ['dist/bootstrap/migrate.js'], {
    cwd: new URL('../backend/', import.meta.url),
    env: { ...process.env, NODE_ENV: 'production', MIGRATION_DATABASE_URL: migrationUrl },
    encoding: 'utf8',
  });
  if (migration.error || migration.status !== 0)
    throw new Error('Falha ao migrar o banco temporário. Confira privilégios e papéis locais.');
  admin = new Pool({ connectionString: migrationUrl, max: 2 });
  database = new Database(runtimeUrl, authUrl);
  jobs = new Jobs(runtimeUrl);
  await jobs.start();
  context = await createApp({
    database,
    jobs,
    jwtSecret: 'isolated-load-benchmark-secret-with-no-real-users',
  });

  async function fixture(cnpj) {
    const storeId = randomUUID(),
      userId = randomUUID();
    await admin.query('INSERT INTO stores(id,cnpj_normalized,name) VALUES($1,$2,$3)', [
      storeId,
      cnpj,
      'Loja sintética de carga',
    ]);
    await admin.query('INSERT INTO store_settings(store_id) VALUES($1)', [storeId]);
    await admin.query(
      "INSERT INTO store_users(id,store_id,username,username_normalized,password_hash,role,must_change_password) VALUES($1,$2,'load','load','unusable-synthetic-password','OWNER',false)",
      [userId, storeId],
    );
    const actor = { storeId, userId, role: 'OWNER', sessionId: randomUUID(), restricted: false };
    const source = await context.integration.createConnection(actor, randomUUID(), 'ERP sintético');
    const key = await context.integration.createKey(actor, source.id, [
      'movements:write',
      'batches:read',
    ]);
    const externalProductId = 'LOAD-PRODUCT';
    const id = stableId(storeId, source.id, externalProductId, 'product');
    await context.prisma.tenant(storeId, (tx) =>
      context.integration.upsertProduct(tx, storeId, source.id, {
        externalProductId,
        description: 'Produto para ensaio',
        barcodes: ['0000012345678'],
      }),
    );
    let count = await context.inventory.createCount(actor, randomUUID(), id);
    count = await context.inventory.updateCount(actor, randomUUID(), count.id, {
      type: 'lines',
      expectedVersion: count.version,
      lines: Array.from({ length: 10 }, (_, index) => ({
        id: randomUUID(),
        quantity: 500,
        expiresOn: `2099-01-${String(index + 1).padStart(2, '0')}`,
        lotCode: `L${index}`,
      })),
    });
    await context.inventory.updateCount(actor, randomUUID(), count.id, {
      type: 'confirm',
      expectedVersion: count.version,
      completeConfirmed: true,
    });
    return { storeId, productId: id, externalProductId, key: key.key };
  }
  const stores = await Promise.all([fixture('11222333000181'), fixture('11444777000161')]);
  timer = setInterval(async () => {
    if (sampling) return;
    sampling = true;
    try {
      const {
        rows: [row],
      } = await admin.query(
        "SELECT count(*) FILTER(WHERE wait_event_type='Lock')::int AS waiting, count(*) FILTER(WHERE state='active')::int AS active FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()",
        [databaseName],
      );
      samples.count += 1;
      samples.maxWaitingForLock = Math.max(samples.maxWaitingForLock, row.waiting);
      samples.maxActiveConnections = Math.max(samples.maxActiveConnections, row.active);
    } finally {
      sampling = false;
    }
  }, 25);

  async function run(store, label, expectedQuantity) {
    const occurredAt = (
      await admin.query(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS instant`,
      )
    ).rows[0].instant;
    const payload = {
      externalBatchId: label,
      events: Array.from({ length: 1000 }, (_, i) => ({
        externalEventId: `${label}-${i}`,
        externalProductId: store.externalProductId,
        type: 'SALE',
        quantity: 1,
        occurredAt,
      })),
    };
    const start = performance.now();
    const response = await context.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/movement-batches',
      headers: { authorization: `Bearer ${store.key}` },
      payload,
    });
    assert.equal(response.statusCode, 202, response.body);
    const acceptedMs = elapsed(start),
      processingStart = performance.now();
    await context.integration.process(store.storeId, response.json().id);
    const processingMs = elapsed(processingStart),
      totalMs = elapsed(start);
    const stock = await context.inventory.detail(store.storeId, store.productId);
    assert.equal(stock.totalQuantity, expectedQuantity);
    assert.equal(stock.stale, false);
    const {
      rows: [batch],
    } = await admin.query('SELECT status FROM import_batches WHERE store_id=$1 AND id=$2', [
      store.storeId,
      response.json().id,
    ]);
    assert.equal(batch.status, 'COMPLETED');
    const replay = await context.app.inject({
      method: 'POST',
      url: '/api/v1/integrations/movement-batches',
      headers: { authorization: `Bearer ${store.key}` },
      payload,
    });
    assert.equal(replay.statusCode, 202, replay.body);
    assert.equal(replay.json().id, response.json().id);
    assert.equal(
      (await context.inventory.detail(store.storeId, store.productId)).totalQuantity,
      expectedQuantity,
    );
    return {
      label,
      events: 1000,
      acceptedMs,
      processingMs,
      totalMs,
      expectedQuantity,
      replayDidNotDuplicate: true,
    };
  }
  const serial = await run(stores[0], 'serial', 4000);
  const start = performance.now();
  const parallel = await Promise.all([
    run(stores[0], 'parallel-a', 3000),
    run(stores[1], 'parallel-b', 4000),
  ]);
  const concurrentWallMs = elapsed(start);
  clearInterval(timer);
  while (sampling) await new Promise((resolve) => setTimeout(resolve, 10));
  const report = {
    measuredAt: new Date().toISOString(),
    environment: {
      node: process.version,
      postgres: (await admin.query('SHOW server_version')).rows[0].server_version,
      platform: process.platform,
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memoryGiB: Math.round(totalmem() / 1024 ** 3),
    },
    method:
      'Banco temporário migrado; Fastify inject com autenticação e DTOs; processador real chamado diretamente; sem espera de polling, TLS ou rede HTTP. Uma amostra por cenário.',
    stockRecordsPerProduct: 10,
    serial,
    parallel,
    concurrentWallMs,
    lockSampling: { intervalMs: 25, ...samples },
    limits: {
      batchEvents: 1000,
      httpBodyBytes: 2097152,
      runtimePool: 10,
      authPool: 3,
      statementTimeoutMs: 15000,
      lockTimeoutMs: 5000,
    },
  };
  await mkdir(new URL('../docs/evidencias/', import.meta.url), { recursive: true });
  await writeFile(
    new URL('../docs/evidencias/import-load.json', import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearInterval(timer);
  while (sampling) await new Promise((resolve) => setTimeout(resolve, 10));
  await context?.app.close();
  await jobs?.stop();
  await context?.prisma.close();
  await database?.close();
  await admin?.end();
  if (created) await control.query(`DROP DATABASE "${databaseName}"`);
  await control.end();
}
