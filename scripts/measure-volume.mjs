// Ensaio de volume: uma loja sintética com o movimento do piloto (10 mil itens vendidos por dia,
// 300 mil por mês) e meses de histórico, num banco temporário. Mede o que roda de hora em hora
// (leitura de vendas da Pagonet e baixa nos lotes), a cada minuto (varredura do worker) e as
// telas mais usadas. Uso:
//
//   pnpm test:volume                    # 2.500 produtos controlados, 183 dias, 10 mil/dia
//   pnpm test:volume -- --days=30 --tracked=300 --daily=2000 --label=rapido
//   pnpm test:volume -- --keep          # mantém o banco temporário para inspeção
//
// O relatório vai para docs/evidencias/volume-<label>.json. Nada sai da máquina: a Pagonet é
// simulada, com as vendas sintéticas.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { cpus, totalmem } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import { createApp } from '../backend/dist/bootstrap/app.js';
import { Database } from '../backend/dist/shared/infrastructure/database.js';
import { Jobs } from '../backend/dist/shared/infrastructure/jobs.js';
import { PagonetSync } from '../backend/dist/modules/integration/adapters/out/pagonet-sync.js';

if (!['development', 'test'].includes(process.env.NODE_ENV))
  throw new Error('O ensaio exige NODE_ENV=development/test e PostgreSQL local migrado.');
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((arg) => arg.startsWith('--'))
    .map((arg) => {
      const [key, value] = arg.slice(2).split('=');
      return [key, value ?? 'true'];
    }),
);
const TRACKED = Number(args.tracked ?? 2500);
const CATALOG = Math.max(TRACKED, Number(args.catalog ?? 25000));
const DAYS = Number(args.days ?? 183);
const DAILY = Number(args.daily ?? 10000);
const LABEL = args.label ?? 'atual';
const KEEP = args.keep === 'true';
const CONCURRENCY = Number(args.concurrency ?? 4);
const TZ = 'America/Sao_Paulo';

const require = createRequire(new URL('../backend/package.json', import.meta.url));
const { Pool } = require('pg');
const argon2 = require('argon2');
const adminUrl = new URL(process.env.MIGRATION_DATABASE_URL);
if (!['localhost', '127.0.0.1', '[::1]'].includes(adminUrl.hostname))
  throw new Error('O ensaio só cria bancos temporários em PostgreSQL local.');
const databaseName = `estoque_volume_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const connection = (value) => {
  const url = new URL(value);
  assert.equal(url.hostname, adminUrl.hostname);
  assert.equal(url.port, adminUrl.port);
  url.pathname = `/${databaseName}`;
  return url.toString();
};
const control = new Pool({ connectionString: adminUrl.toString(), max: 1 });
const ms = (start) => Math.round(performance.now() - start);
const log = (...parts) => console.log(new Date().toISOString().slice(11, 19), ...parts);
const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};
const stats = (values) => ({
  n: values.length,
  p50: percentile(values, 50),
  p95: percentile(values, 95),
  max: values.length ? Math.max(...values) : null,
  total: values.reduce((a, b) => a + b, 0),
});
async function pool(items, size, fn) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: size }, async () => {
      while (queue.length) await fn(queue.shift());
    }),
  );
}

let admin,
  database,
  jobs,
  context,
  created = false;
const report = { label: LABEL, measuredAt: new Date().toISOString(), scenario: {}, results: {} };
try {
  await control.query(`CREATE DATABASE "${databaseName}"`);
  created = true;
  const migration = spawnSync(process.execPath, ['dist/bootstrap/migrate.js'], {
    cwd: new URL('../backend/', import.meta.url),
    env: {
      ...process.env,
      NODE_ENV: 'production',
      MIGRATION_DATABASE_URL: connection(adminUrl),
    },
    encoding: 'utf8',
  });
  if (migration.error || migration.status !== 0)
    throw new Error(`Falha ao migrar o banco temporário: ${migration.stderr || migration.error}`);
  admin = new Pool({ connectionString: connection(adminUrl), max: 4 });
  // UUID determinístico e válido (versão 4, variante RFC), para as rotas aceitarem.
  await admin.query(
    `CREATE FUNCTION seed_uuid(text) RETURNS uuid LANGUAGE sql IMMUTABLE
       AS $$ SELECT overlay(overlay(md5($1) placing '4' from 13) placing 'a' from 17)::uuid $$`,
  );
  database = new Database(
    connection(process.env.DATABASE_URL),
    connection(process.env.AUTH_DATABASE_URL),
  );
  jobs = new Jobs(connection(process.env.DATABASE_URL));
  await jobs.start();
  context = await createApp({
    database,
    jobs,
    jwtSecret: 'isolated-volume-benchmark-secret-with-no-real-users',
    notificationChannels: [],
  });
  const has = async (table) =>
    (await admin.query('SELECT to_regclass($1) IS NOT NULL AS ok', [`public.${table}`])).rows[0].ok;

  // ---------------------------------------------------------------------------------------
  // Loja, catálogo e contagens
  // ---------------------------------------------------------------------------------------
  const storeId = randomUUID(),
    userId = randomUUID(),
    connectionId = randomUUID();
  const cnpj = '11222333000181';
  const password = `Volume-${randomUUID()}`;
  let start = performance.now();
  await admin.query(
    `INSERT INTO stores(id, cnpj_normalized, name, timezone) VALUES ($1, $2, 'Loja sintética de volume', $3)`,
    [storeId, cnpj, TZ],
  );
  await admin.query('INSERT INTO store_settings(store_id) VALUES ($1)', [storeId]);
  await admin.query(
    `INSERT INTO store_users(id, store_id, username, username_normalized, password_hash, role, must_change_password)
     VALUES ($1, $2, 'dono', 'dono', $3, 'OWNER', false)`,
    [
      userId,
      storeId,
      await argon2.hash(password, {
        type: argon2.argon2id,
        memoryCost: 19456,
        timeCost: 2,
        parallelism: 1,
      }),
    ],
  );
  await admin.query(
    `INSERT INTO integration_connections(id, store_id, name) VALUES ($1, $2, 'Pagonet — Facilita Validade')`,
    [connectionId, storeId],
  );
  // Início do histórico: meia-noite local de DAYS dias atrás. A contagem de todos os produtos
  // controlados foi nesse instante.
  const {
    rows: [clock],
  } = await admin.query(
    `SELECT ((date_trunc('day', clock_timestamp() AT TIME ZONE $1) - make_interval(days => $2)) AT TIME ZONE $1) AS t0,
            to_char((clock_timestamp() AT TIME ZONE $1)::date, 'YYYY-MM-DD') AS today`,
    [TZ, DAYS],
  );
  const t0 = clock.t0;
  await admin.query(
    `CREATE TABLE seed_products AS
     SELECT g, seed_uuid($1::text || ':product:' || g) AS id, (100000 + g)::text AS external,
            CASE WHEN g <= $2 THEN $3::numeric * (1.0 / (g + 5)) / s.total END AS rate
       FROM generate_series(1, $4::int) g,
            (SELECT sum(1.0 / (x + 5)) AS total FROM generate_series(1, $2::int) x) s`,
    [storeId, TRACKED, DAILY, CATALOG],
  );
  await admin.query(
    `INSERT INTO products(id, store_id, integration_connection_id, external_product_id, description, active, sale_price)
     SELECT id, $1::uuid, $2::uuid, external, 'Produto sintético ' || g, true, (2 + g % 37)::numeric FROM seed_products`,
    [storeId, connectionId],
  );
  await admin.query(
    `INSERT INTO product_inventory(store_id, product_id) SELECT $1::uuid, id FROM seed_products`,
    [storeId],
  );
  await admin.query(
    `INSERT INTO count_sessions(id, store_id, product_id, actor_id, status, version, started_at, cutoff_at)
     SELECT seed_uuid($1::text || ':count:' || g), $1::uuid, id, $2::uuid, 'CONFIRMED', 3, $3::timestamptz - interval '1 hour', $3
       FROM seed_products WHERE rate IS NOT NULL`,
    [storeId, userId, t0],
  );
  await admin.query(
    `INSERT INTO inventory_epochs(id, store_id, product_id, session_id, cutoff_at, count_started_at)
     SELECT seed_uuid($1::text || ':epoch:' || g), $1::uuid, id, seed_uuid($1::text || ':count:' || g), $2,
            $2::timestamptz - interval '1 hour'
       FROM seed_products WHERE rate IS NOT NULL`,
    [storeId, t0],
  );
  // Três lotes contados por produto, com uns dias de venda cada.
  await admin.query(
    `INSERT INTO stock_records(id, store_id, product_id, epoch_id, origin, expires_on, lot_code,
                               initial_quantity, available_at, allocation_priority_at, created_by)
     SELECT seed_uuid($1::text || ':count-record:' || g || ':' || l), $1::uuid, id, seed_uuid($1::text || ':epoch:' || g),
            'COUNT', ($2::timestamptz AT TIME ZONE $3)::date + 3 + l * 4, 'C' || l,
            ceil(rate * 2) + 3, $2, $2::timestamptz - interval '30 minutes' + l * interval '1 minute', $4::uuid
       FROM seed_products, generate_series(1, 3) l WHERE rate IS NOT NULL`,
    [storeId, t0, TZ, userId],
  );
  await admin.query(
    `UPDATE product_inventory i
        SET epoch_id = seed_uuid($1::text || ':epoch:' || p.g), tracking_status = 'TRACKED',
            input_revision = 1
       FROM seed_products p
      WHERE i.store_id = $1::uuid AND i.product_id = p.id AND p.rate IS NOT NULL`,
    [storeId],
  );
  log(`catálogo de ${CATALOG} produtos, ${TRACKED} controlados: ${ms(start)} ms`);

  // ---------------------------------------------------------------------------------------
  // Entradas e vendas
  // ---------------------------------------------------------------------------------------
  start = performance.now();
  // Entrada a cada `period` dias, às 6h: o suficiente para o período e um pouco mais.
  await admin.query(
    `WITH r AS (
       SELECT p.g, p.id AS product_id, k,
              seed_uuid($1::text || ':receipt:' || p.g || ':' || k) AS mid,
              seed_uuid($1::text || ':receipt-record:' || p.g || ':' || k) AS rid,
              ceil(p.rate * per.period * 1.1)::int + 2 AS quantity,
              $2::timestamptz + make_interval(days => k, hours => 6) AS at
         FROM seed_products p
        CROSS JOIN LATERAL (SELECT greatest(1, least(14, round(40 / p.rate)))::int AS period) per
        CROSS JOIN LATERAL generate_series(per.period, $3::int, per.period) k
        WHERE p.rate IS NOT NULL)
     INSERT INTO stock_movements(id, store_id, product_id, occurred_at, payload)
     SELECT mid, $1::uuid, product_id, at,
            jsonb_build_object(
              'id', mid, 'storeId', $1::text, 'productId', product_id, 'type', 'APP_RECEIPT',
              'quantity', quantity,
              'expiresOn', to_char((at AT TIME ZONE $4)::date + 7 + g % 30, 'YYYY-MM-DD'),
              'lotCode', 'R' || k, 'stockRecordId', rid, 'actorId', $5::text,
              'occurredAt', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
              'source', jsonb_build_object('kind', 'APP', 'commandId', seed_uuid(mid::text)))
       FROM r WHERE at < clock_timestamp() - interval '1 hour'`,
    [storeId, t0, DAYS, TZ, userId],
  );
  // Vendas de 7h às 22h, com hora em minutos como as da Pagonet; até poucos minutos atrás.
  await admin.query(
    `CREATE TABLE seed_sales AS
     SELECT row_number() OVER (ORDER BY at, product_id) + 1000000 AS seq, product_id, external, at,
            to_char(at AT TIME ZONE $3, 'YYYY-MM-DD') AS day, to_char(at AT TIME ZONE $3, 'HH24:MI') AS hora
       FROM (SELECT p.id AS product_id, p.external,
                    $1::timestamptz + make_interval(days => k, hours => 7)
                      + floor(random() * 900) * interval '1 minute' AS at
               FROM seed_products p
              CROSS JOIN generate_series(0, $2::int) k
              CROSS JOIN LATERAL generate_series(1, floor(p.rate + random())::int) s
              WHERE p.rate IS NOT NULL) x
      WHERE at < clock_timestamp() - interval '3 minutes'`,
    [t0, DAYS, TZ],
  );
  await admin.query('CREATE INDEX ON seed_sales (day)');
  const {
    rows: [{ sales }],
  } = await admin.query('SELECT count(*)::int AS sales FROM seed_sales');
  // Um lote de importação por dia, já concluído.
  await admin.query(
    `INSERT INTO import_batches(id, store_id, connection_id, external_batch_id, payload_hash, kind, status, payload, completed_at)
     SELECT seed_uuid($1::text || ':batch:' || day), $1::uuid, $2::uuid, 'seed:' || day, 'seed', 'MOVEMENTS', 'COMPLETED', '{}'::jsonb, clock_timestamp()
       FROM (SELECT DISTINCT day FROM seed_sales) d`,
    [storeId, connectionId],
  );
  // Mesmos ids da importação de verdade (stableId), para a leitura seguinte reconhecer os itens.
  const eventId = (
    ext,
  ) => `(SELECT substr(h, 1, 8) || '-' || substr(h, 9, 4) || '-8' || substr(h, 14, 3) || '-a' || substr(h, 18, 3) || '-' || substr(h, 21, 12)
        FROM (SELECT encode(sha256(convert_to(format('["controle-estoque:v1","%s","%s","%s"]', $1::text, $2::text, ${ext}), 'UTF8')), 'hex') AS h) x)::uuid`;
  await admin.query(
    `INSERT INTO integration_events(id, store_id, connection_id, batch_id, external_event_id, payload_hash, payload, status, received_at)
     SELECT ${eventId("'venda:' || day || ':' || seq")}, $1::uuid, $2::uuid, seed_uuid($1::text || ':batch:' || day),
            'venda:' || day || ':' || seq, md5(seq::text),
            jsonb_build_object('externalEventId', 'venda:' || day || ':' || seq, 'externalProductId', external,
                               'type', 'SALE', 'quantity', 1,
                               'occurredAt', to_char(at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
            'ACCEPTED', at + interval '4 minutes'
       FROM seed_sales`,
    [storeId, connectionId],
  );
  await admin.query(
    `INSERT INTO stock_movements(id, store_id, product_id, event_id, occurred_at, payload)
     SELECT e.id, $1::uuid, s.product_id, e.id, s.at,
            jsonb_build_object('id', e.id, 'storeId', $1::text, 'productId', s.product_id,
                               'occurredAt', to_char(s.at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                               'source', jsonb_build_object('kind', 'ERP', 'connectionId', $2::text,
                                                            'externalEventId', e.external_event_id),
                               'type', 'SALE', 'quantity', 1)
       FROM seed_sales s
       JOIN integration_events e ON e.store_id = $1::uuid AND e.connection_id = $2::uuid
        AND e.external_event_id = 'venda:' || s.day || ':' || s.seq`,
    [storeId, connectionId],
  );
  // Vendas por dia de todo o catálogo, se o banco já guarda (média de 6 meses).
  const dailySales = await has('product_daily_sales');
  if (dailySales) {
    await admin.query(
      `INSERT INTO product_daily_sales(store_id, day, product_id, units)
       SELECT $1::uuid, day::date, product_id, count(*) FROM seed_sales WHERE day < $2 GROUP BY day, product_id`,
      [storeId, clock.today],
    );
    // Produtos não controlados também vendem: uns 2 mil por dia.
    await admin.query(
      `INSERT INTO product_daily_sales(store_id, day, product_id, units)
       SELECT $1::uuid, d::date, p.id, 1 + floor(random() * 4)
         FROM generate_series(($2::date - $3::int), $2::date - 1, interval '1 day') d
         JOIN seed_products p ON p.rate IS NULL AND random() < 2000.0 / greatest(1, $4::int - $5::int)
       ON CONFLICT DO NOTHING`,
      [storeId, clock.today, DAYS, CATALOG, TRACKED],
    );
    await admin.query(
      `INSERT INTO sales_days(store_id, day, items, units, read_at)
       SELECT $1::uuid, d::date, 0, 0, clock_timestamp()
         FROM generate_series(($2::date - $3::int), $2::date - 1, interval '1 day') d`,
      [storeId, clock.today, DAYS],
    );
  }
  await admin.query('ANALYZE');
  log(`${sales} vendas e as entradas: ${ms(start)} ms`);
  report.scenario = {
    trackedProducts: TRACKED,
    catalogProducts: CATALOG,
    historyDays: DAYS,
    dailySalesTarget: DAILY,
    saleMovements: sales,
    topProductSalesPerDay: Number(
      (await admin.query('SELECT max(rate)::float AS r FROM seed_products')).rows[0].r.toFixed(1),
    ),
  };

  // ---------------------------------------------------------------------------------------
  // Primeira reconstrução de todos os produtos (a de hoje refaz tudo; mede o pior caso)
  // ---------------------------------------------------------------------------------------
  const tracked = (
    await admin.query(
      `SELECT p.id, p.external, p.rate::float AS rate,
              (SELECT count(*) FROM stock_movements m WHERE m.store_id = $1 AND m.product_id = p.id)::int AS facts
         FROM seed_products p WHERE p.rate IS NOT NULL ORDER BY p.g`,
      [storeId],
    )
  ).rows;
  start = performance.now();
  const rebuildTimes = [];
  let topRebuild = null;
  await pool(tracked, CONCURRENCY, async (product) => {
    const s = performance.now();
    await context.prisma.tenant(storeId, (tx) =>
      context.inventory.rebuild(tx, storeId, product.id),
    );
    const t = ms(s);
    rebuildTimes.push(t);
    if (product === tracked[0]) topRebuild = { facts: product.facts, ms: t };
  });
  report.results.initialRebuild = {
    wallMs: ms(start),
    concurrency: CONCURRENCY,
    perProductMs: stats(rebuildTimes),
    topProduct: topRebuild,
  };
  log('reconstrução inicial', JSON.stringify(report.results.initialRebuild));
  await admin.query('ANALYZE');
  const afterInitial = (await admin.query('SELECT clock_timestamp() AS t')).rows[0].t;

  // ---------------------------------------------------------------------------------------
  // Varredura do worker (a cada minuto)
  // ---------------------------------------------------------------------------------------
  const timed = async (fn) => {
    const s = performance.now();
    await fn();
    return ms(s);
  };
  report.results.sweep = {
    recoverMs: await timed(() => context.integration.recover(storeId)),
    evaluateFirstMs: await timed(() => context.notifications.evaluate(storeId)),
    evaluateSteadyMs: [
      await timed(() => context.notifications.evaluate(storeId)),
      await timed(() => context.notifications.evaluate(storeId)),
    ],
  };
  if (typeof context.notifications.refreshSalesRates === 'function')
    report.results.sweep.salesRatesMs = await timed(() =>
      context.prisma.tenant(storeId, (tx) => context.notifications.refreshSalesRates(tx, storeId)),
    );
  log('varredura', JSON.stringify(report.results.sweep));

  // ---------------------------------------------------------------------------------------
  // Leitura de hora em hora da Pagonet, simulada: o dia todo até agora mais a última hora
  // ---------------------------------------------------------------------------------------
  const weights = tracked.map((p) => p.rate);
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  const pick = () => {
    let r = Math.random() * totalWeight;
    for (let i = 0; i < tracked.length; i++) if ((r -= weights[i]) <= 0) return tracked[i];
    return tracked.at(-1);
  };
  let nextSeq = 9_000_000;
  const extra = new Map();
  const fakeClient = {
    async sales(_token, _cnpj, date) {
      const { rows } = await admin.query(
        'SELECT seq::text AS id, hora, external FROM seed_sales WHERE day = $1',
        [date],
      );
      return [...rows, ...(extra.get(date) ?? [])].map((row) => ({
        id: row.id,
        data: `${date}T00:00:00`,
        hora: row.hora,
        codprod: row.external,
        qtd: 1,
      }));
    },
  };
  const yesterday = (
    await admin.query(`SELECT to_char($1::date - 1, 'YYYY-MM-DD') AS d`, [clock.today])
  ).rows[0].d;
  await admin.query(
    `INSERT INTO pagonet_sources(store_id, connection_id, active, catalog_synced_at, catalog_hash, sales_state)
     VALUES ($1, $2, true, clock_timestamp(), 'seed', $3)`,
    [
      storeId,
      connectionId,
      JSON.stringify({
        days: {
          [yesterday]: { closingReads: 2, missing: {} },
          [clock.today]: { closingReads: 0, missing: {} },
        },
      }),
    ],
  );
  const pagonet = new PagonetSync(
    context.prisma,
    jobs,
    context.integration,
    fakeClient,
    'token-simulado',
  );
  const hourly = [];
  for (let round = 0; round < 3; round++) {
    // Uns 700 itens novos na última hora (o pico: 10 mil em 15 horas de loja aberta).
    const {
      rows: [now],
    } = await admin.query(
      `SELECT to_char(clock_timestamp() AT TIME ZONE $1, 'HH24:MI') AS hora,
              extract(hour FROM clock_timestamp() AT TIME ZONE $1)::int * 60
              + extract(minute FROM clock_timestamp() AT TIME ZONE $1)::int AS minutes`,
      [TZ],
    );
    const fresh = extra.get(clock.today) ?? [];
    const count = Math.round(DAILY / 15);
    for (let i = 0; i < count; i++) {
      const minute = Math.max(0, now.minutes - 2 - Math.floor(Math.random() * 60));
      const hora = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      fresh.push({ id: String(nextSeq++), hora, external: pick().external });
    }
    extra.set(clock.today, fresh);
    await admin.query('UPDATE pagonet_sources SET sales_attempted_at = NULL WHERE store_id = $1', [
      storeId,
    ]);
    const readMs = await timed(() => pagonet.syncSales(storeId));
    const batches = (
      await admin.query(
        `SELECT id FROM import_batches WHERE store_id = $1 AND status = 'RECEIVED' ORDER BY created_at`,
        [storeId],
      )
    ).rows;
    const processMs = await timed(async () => {
      for (const batch of batches) await context.integration.process(storeId, batch.id);
    });
    const {
      rows: [state],
    } = await admin.query('SELECT last_error FROM pagonet_sources WHERE store_id = $1', [storeId]);
    assert.equal(state.last_error, null, state.last_error);
    // A reavaliação dos produtos que venderam, como o job faz depois de cada baixa.
    const touched = (
      await admin.query(
        `SELECT DISTINCT data->>'productId' AS id FROM pgboss.job
          WHERE name = 'notifications.evaluate' AND state = 'created' AND data->>'storeId' = $1`,
        [storeId],
      )
    ).rows.filter((row) => row.id);
    // Como o worker: os jobs de reavaliação chegam em lotes de 100.
    const evaluateMs = await timed(async () => {
      for (let i = 0; i < touched.length; i += 100)
        await context.notifications.evaluate(
          storeId,
          touched.slice(i, i + 100).map((row) => row.id),
        );
    });
    await admin.query(`DELETE FROM pgboss.job WHERE name = 'notifications.evaluate'`);
    hourly.push({
      newItems: count,
      batches: batches.length,
      readMs,
      processMs,
      evaluatedProducts: touched.length,
      evaluateMs,
    });
    log('leitura de hora em hora', JSON.stringify(hourly.at(-1)));
  }
  report.results.hourlySalesRead = hourly;

  // Leitura de fechamento de um dia inteiro já importado (só confere e não muda nada).
  await admin.query(
    `UPDATE pagonet_sources SET sales_attempted_at = NULL,
            sales_state = jsonb_set(sales_state, '{days}', $2::jsonb)
      WHERE store_id = $1`,
    [
      storeId,
      JSON.stringify({
        [yesterday]: { closingReads: 1, missing: {} },
        [clock.today]: { closingReads: 0, missing: {} },
      }),
    ],
  );
  report.results.closingRead = { readMs: await timed(() => pagonet.syncSales(storeId)) };
  log('fechamento do dia', JSON.stringify(report.results.closingRead));

  // Um dia antigo do histórico (média de 6 meses), se a leitura existir.
  if (typeof pagonet.syncHistory === 'function') {
    await admin.query(`UPDATE pagonet_sources SET sales_attempted_at = NULL WHERE store_id = $1`, [
      storeId,
    ]);
    await admin.query(`DELETE FROM sales_days WHERE store_id = $1 AND day = $2::date - 2`, [
      storeId,
      clock.today,
    ]);
    report.results.historyRead = { readMs: await timed(() => pagonet.syncHistory(storeId)) };
    log('dia do histórico', JSON.stringify(report.results.historyRead));
  }

  // Reconstruções feitas nas leituras de hora em hora: completas ou retomadas de um retrato.
  report.results.rebuildModes = Object.fromEntries(
    (
      await admin.query(
        `SELECT coalesce(summary->>'mode', 'FULL') AS mode, count(*)::int AS n
           FROM projection_runs WHERE store_id = $1 AND created_at > $2 GROUP BY 1`,
        [storeId, afterInitial],
      )
    ).rows.map((row) => [row.mode, row.n]),
  );

  // ---------------------------------------------------------------------------------------
  // Conferência: produtos refeitos do zero com o motor e comparados com o que está gravado
  // (saldo, lançado, vendido, baixa manual, status, de que lote saiu cada venda, pendências).
  // Os 30 que mais vendem e mais 70 ao acaso.
  // ---------------------------------------------------------------------------------------
  {
    const { rebuildInventory } = await import('../backend/dist/modules/inventory/domain/index.js');
    const { recordTotals } =
      await import('../backend/dist/modules/inventory/domain/record-totals.js');
    const rest = tracked.slice(30).sort(() => Math.random() - 0.5);
    const sample = [...tracked.slice(0, 30), ...rest.slice(0, 70)];
    let differences = 0;
    const start = performance.now();
    for (const product of sample)
      await context.prisma.tenant(
        storeId,
        async (tx) => {
          const [state] = await tx.$queryRaw`
            SELECT epoch_id FROM product_inventory
             WHERE store_id = ${storeId}::uuid AND product_id = ${product.id}::uuid`;
          const now = await context.inventory.now(tx);
          const { facts, resolutions, baseline } = await context.inventory.inputs(
            tx,
            storeId,
            product.id,
            state.epoch_id,
          );
          const projection = rebuildInventory({
            storeId,
            productId: product.id,
            trackingStatus: 'TRACKED',
            baseline,
            movements: facts,
            resolutions,
            projectionAsOf: now,
          });
          const lots = new Map(
            (
              await tx.$queryRaw`
                SELECT p.record_id, p.quantity, to_char(p.expires_on, 'YYYY-MM-DD') AS expires_on,
                       p.launched, p.sold, p.written_off, p.status
                  FROM stock_projections p JOIN stock_records r ON r.store_id = p.store_id AND r.id = p.record_id
                 WHERE r.store_id = ${storeId}::uuid AND r.product_id = ${product.id}::uuid
                   AND r.epoch_id = ${state.epoch_id}::uuid`
            ).map((row) => [row.record_id, row]),
          );
          for (const row of recordTotals(projection)) {
            const lot = lots.get(row.recordId);
            if (
              !lot ||
              lot.quantity !== row.quantity ||
              lot.launched !== row.launched ||
              lot.sold !== row.sold ||
              lot.written_off !== row.writtenOff ||
              lot.status !== row.status ||
              lot.expires_on !== row.expiresOn
            )
              differences++;
          }
          const stored = new Set(
            (
              await tx.$queryRaw`
                SELECT movement_id || '|' || record_id || '|' || quantity AS k FROM movement_allocations
                 WHERE store_id = ${storeId}::uuid AND epoch_id = ${state.epoch_id}::uuid`
            ).map((row) => row.k),
          );
          const wanted = new Set(
            projection.allocations.map((a) => `${a.movementId}|${a.stockRecordId}|${a.quantity}`),
          );
          for (const key of wanted) if (!stored.has(key)) differences++;
          for (const key of stored) if (!wanted.has(key)) differences++;
          const open = new Set(
            (
              await tx.$queryRaw`
                SELECT identity FROM reconciliation_issues
                 WHERE store_id = ${storeId}::uuid AND product_id = ${product.id}::uuid AND status = 'OPEN'`
            ).map((row) => row.identity),
          );
          const raised = new Set(
            projection.issues.map((issue) => `${issue.code}:${issue.movementId}`),
          );
          for (const key of raised) if (!open.has(key)) differences++;
          for (const key of open) if (!raised.has(key)) differences++;
        },
        { readOnlySnapshot: true },
      );
    report.results.verification = { products: sample.length, differences, ms: ms(start) };
    log('conferência', JSON.stringify(report.results.verification));
    assert.equal(differences, 0, 'O que está gravado difere da reconstrução completa.');
  }

  // ---------------------------------------------------------------------------------------
  // Telas
  // ---------------------------------------------------------------------------------------
  const login = await context.app.inject({
    method: 'POST',
    url: '/api/v1/auth/mobile/login',
    payload: { cnpj, username: 'dono', password },
  });
  assert.equal(login.statusCode, 200, login.body);
  const token = login.json().accessToken;
  const top = tracked[0].id;
  const oldRecord = (
    await admin.query(
      `SELECT id FROM stock_records WHERE store_id = $1 AND product_id = $2 ORDER BY allocation_priority_at LIMIT 1 OFFSET 5`,
      [storeId, top],
    )
  ).rows[0]?.id;
  const screens = {
    inicio: '/dashboard/summary',
    validades: '/inventory/expiries?limit=50',
    validadesResumo: '/inventory/expiries/summary',
    estoque: '/inventory?limit=50',
    produto: `/inventory/products/${top}`,
    historico: `/inventory/products/${top}/history?limit=50`,
    historicoDoLote: `/inventory/products/${top}/history?limit=50&recordId=${oldRecord}`,
    alertas: '/notifications?limit=50',
    catalogo: '/products?search=sint%C3%A9tico%2012',
    pendencias: '/reconciliation-issues?limit=50',
  };
  report.results.screensMs = {};
  for (const [name, url] of Object.entries(screens)) {
    const times = [];
    for (let i = 0; i < 5; i++) {
      const s = performance.now();
      const response = await context.app.inject({
        method: 'GET',
        url: `/api/v1${url}`,
        headers: { authorization: `Bearer ${token}` },
      });
      times.push(ms(s));
      assert.ok(
        response.statusCode < 300,
        `${url}: ${response.statusCode} ${response.body.slice(0, 300)}`,
      );
    }
    report.results.screensMs[name] = percentile(times, 50);
  }
  log('telas (mediana de 5)', JSON.stringify(report.results.screensMs));

  // ---------------------------------------------------------------------------------------
  // Tamanho das tabelas e ambiente
  // ---------------------------------------------------------------------------------------
  report.tables = Object.fromEntries(
    (
      await admin.query(
        `SELECT c.relname, pg_total_relation_size(c.oid) AS bytes, c.reltuples::bigint AS rows
           FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT LIKE 'seed_%'
          ORDER BY pg_total_relation_size(c.oid) DESC LIMIT 12`,
      )
    ).rows.map((row) => [
      row.relname,
      { mb: Math.round(Number(row.bytes) / 1048576), rows: Number(row.rows) },
    ]),
  );
  report.environment = {
    node: process.version,
    postgres: (await admin.query('SHOW server_version')).rows[0].server_version,
    sharedBuffers: (await admin.query('SHOW shared_buffers')).rows[0].shared_buffers,
    platform: process.platform,
    cpu: cpus()[0]?.model,
    logicalCpus: cpus().length,
    memoryGiB: Math.round(totalmem() / 1024 ** 3),
  };
  await mkdir(new URL('../docs/evidencias/', import.meta.url), { recursive: true });
  await writeFile(
    new URL(`../docs/evidencias/volume-${LABEL}.json`, import.meta.url),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(JSON.stringify(report, null, 2));
  if (KEEP) console.log(`Banco mantido: ${databaseName}`);
} finally {
  await context?.app.close();
  await jobs?.stop();
  await context?.prisma.close();
  await database?.close();
  await admin?.end();
  if (created && !KEEP) await control.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
  await control.end();
}
