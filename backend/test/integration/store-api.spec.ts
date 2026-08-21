import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { hash, argon2id } from 'argon2';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/bootstrap/app.js';
import { Jobs } from '../../src/shared/infrastructure/jobs.js';
import { testCnpj } from '../support/cnpj.js';

describe('Loja: dados, configurações, operações, auditoria e painel', () => {
  const storeId = randomUUID(),
    ownerId = randomUUID(),
    cnpj = testCnpj();
  const password = 'TesteLojaApi!2026';
  let admin: Pool, jobs: Jobs, ctx: Awaited<ReturnType<typeof createApp>>, token: string;

  function call(
    path: string,
    method: InjectOptions['method'] = 'GET',
    body?: unknown,
    key?: string,
  ) {
    return ctx.app.inject({
      method,
      url: `/api/v1${path}`,
      headers: {
        authorization: `Bearer ${token}`,
        'idempotency-key': key ?? randomUUID(),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      payload: body ? JSON.stringify(body) : undefined,
    });
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await admin.query("INSERT INTO stores(id,cnpj_normalized,name) VALUES($1,$2,'Loja da API')", [
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
      jwtSecret: 'test-store-api-secret-at-least-thirty-two-bytes',
      notificationChannels: [],
    });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mobile/login',
      payload: { cnpj, username: 'dono', password },
    });
    expect(login.statusCode, login.body).toBe(200);
    token = login.json().accessToken;
  });

  afterAll(async () => {
    await ctx?.app.close();
    await jobs?.stop();
    if (admin) {
      await admin.query("DELETE FROM pgboss.job WHERE data->>'storeId'=$1", [storeId]);
      for (const table of [
        'integration_events',
        'import_batches',
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

  it('devolve os dados da loja e as configurações iniciais', async () => {
    expect((await call('/store')).json()).toEqual({ id: storeId, name: 'Loja da API', cnpj });
    expect((await call('/store/settings')).json()).toEqual({
      version: 1,
      timezone: 'America/Sao_Paulo',
      alertEmails: [],
      digestHour: 7,
      salesForecastAlerts: false,
      lastDigestDate: null,
      lastDigestStatus: null,
      lastDigestAt: null,
      lastDigestError: null,
      emailAvailable: false,
    });
  });

  it('salva com trava de versão, repete pela mesma chave e expõe o resultado da operação', async () => {
    const key = randomUUID();
    const input = {
      expectedVersion: 1,
      timezone: 'America/Manaus',
      alertEmails: [' Gerente@Loja.com.br ', 'gerente@loja.com.br'],
      digestHour: 6,
    };
    const saved = await call('/store/settings', 'PATCH', input, key);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      version: 2,
      timezone: 'America/Manaus',
      alertEmails: ['gerente@loja.com.br'],
      digestHour: 6,
    });

    // Mesma chave e mesmo conteúdo: devolve o resultado gravado, sem aplicar de novo.
    const replay = await call('/store/settings', 'PATCH', input, key);
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toEqual(saved.json());
    expect((await call('/store/settings')).json()).toMatchObject({ version: 2 });

    const reused = await call('/store/settings', 'PATCH', { ...input, digestHour: 4 }, key);
    expect(reused.statusCode).toBe(409);
    expect(reused.json()).toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });

    const stale = await call('/store/settings', 'PATCH', { ...input, digestHour: 4 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    // Deslocamento em vez de nome: o Node entende -03:00 como UTC−3, o PostgreSQL como
    // UTC+3 (convenção POSIX). Aceitar deixaria a data local da loja 6 horas errada.
    for (const timezone of ['-03:00', 'Brasilia', 'america/sao_paulo']) {
      const refused = await call('/store/settings', 'PATCH', {
        ...input,
        expectedVersion: 2,
        timezone,
      });
      expect(refused.statusCode, timezone).toBe(422);
      expect(refused.json()).toMatchObject({ code: 'INVALID_TIMEZONE' });
    }

    const operation = await call(`/operations/${key}?operation=store.settings`);
    expect(operation.statusCode, operation.body).toBe(200);
    expect(operation.json()).toEqual({
      operation: 'store.settings',
      idempotencyKey: key,
      result: saved.json(),
    });
    for (const query of ['', '?operation=', '?operation=count.create']) {
      const unknown = await call(`/operations/${key}${query}`);
      expect(unknown.statusCode, query).toBe(404);
      expect(unknown.json()).toMatchObject({ code: 'OPERATION_UNKNOWN' });
    }

    // Omitir destinatários e horário mantém os valores salvos.
    const kept = await call('/store/settings', 'PATCH', {
      expectedVersion: 2,
      timezone: 'America/Sao_Paulo',
    });
    expect(kept.statusCode, kept.body).toBe(200);
    expect(kept.json()).toMatchObject({
      version: 3,
      alertEmails: ['gerente@loja.com.br'],
      digestHour: 6,
    });
  });

  it('pagina a auditoria sem pular nem repetir eventos do mesmo milissegundo', async () => {
    // Instantes que só diferem nos microssegundos, e um empate exato desfeito pelo ID.
    const instants = [
      '2026-01-01T00:00:00.123100Z',
      '2026-01-01T00:00:00.123200Z',
      '2026-01-01T00:00:00.123300Z',
      '2026-01-01T00:00:00.123300Z',
      '2026-01-01T00:00:00.124000Z',
      '2026-01-01T00:00:00.122999Z',
    ];
    const events = instants.map((at) => ({ id: randomUUID(), at }));
    for (const event of events)
      await admin.query(
        "INSERT INTO audit_events(id,store_id,action,created_at) VALUES($1,$2,'PAGINATION_TEST',$3)",
        [event.id, storeId, event.at],
      );
    const expected = [...events]
      .sort((a, b) => (a.at === b.at ? (a.id < b.id ? 1 : -1) : a.at < b.at ? 1 : -1))
      .map((event) => event.id);

    const collected: string[] = [];
    let cursor: string | null = null;
    do {
      const response = await call(`/audit-events?limit=2${cursor ? `&cursor=${cursor}` : ''}`);
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json() as { items: { id: string }[]; nextCursor: string | null };
      collected.push(...body.items.map((item) => item.id));
      cursor = body.nextCursor;
    } while (cursor);

    const mine = new Set<string>(events.map((event) => event.id));
    expect(collected.filter((id) => mine.has(id))).toEqual(expected);
    expect(new Set(collected).size).toBe(collected.length);
  });

  it('resume o painel com contagens inteiras e a última importação', async () => {
    const connectionId = randomUUID();
    await admin.query(
      "INSERT INTO integration_connections(id,store_id,name) VALUES($1,$2,'ERP do painel')",
      [connectionId, storeId],
    );
    // Pendente é o que ainda vai andar sozinho: lote não processado ou com evento à
    // espera de produto, de referência ou do próprio horário. Erro definitivo não é.
    for (const [status, completedAt, eventStatus] of [
      ['COMPLETED', '2026-09-29T10:00:00.123456Z', null],
      ['RECEIVED', null, null],
      ['COMPLETED_WITH_ISSUES', '2026-09-28T10:00:00Z', 'UNSUPPORTED_QUANTITY'],
      ['COMPLETED_WITH_ISSUES', '2026-09-27T10:00:00Z', 'PENDING_PRODUCT'],
    ] as const) {
      const batchId = randomUUID();
      await admin.query(
        "INSERT INTO import_batches(id,store_id,connection_id,external_batch_id,payload_hash,kind,payload,status,completed_at) VALUES($1,$2,$3,$4,'hash','MOVEMENTS','{}',$5,$6)",
        [batchId, storeId, connectionId, randomUUID(), status, completedAt],
      );
      if (eventStatus)
        await admin.query(
          "INSERT INTO integration_events(id,store_id,connection_id,batch_id,external_event_id,payload_hash,payload,status) VALUES($1,$2,$3,$4,$5,'hash','{}',$6)",
          [randomUUID(), storeId, connectionId, batchId, randomUUID(), eventStatus],
        );
    }
    const response = await call('/dashboard/summary');
    expect(response.statusCode, response.body).toBe(200);
    const summary = response.json();
    expect(summary).toMatchObject({
      trackedProducts: 0,
      atRiskRecords: 0,
      expiredRecords: 0,
      openIssues: 0,
      unreadNotifications: 0,
      pendingImports: 2,
      // Sem origem que o servidor busca sozinho, só se sabe a hora da última importação.
      salesThroughAt: null,
      salesDelayed: false,
      stockValue: 0,
      expiringValue: 0,
      expiredValue: 0,
      unpricedLots: 0,
    });
    expect(summary.levels.map((level: { name: string }) => level.name)).toEqual([
      'Vencido',
      'Urgente',
      'Atenção',
      'Em dia',
    ]);
    expect(summary.upcomingWeeks).toHaveLength(6);
    expect(Date.parse(summary.lastImportAt)).toBe(Date.parse('2026-09-29T10:00:00.123Z'));
  });

  it('níveis de urgência: preserva os cadastrados, deriva os intervalos e recusa limites iguais', async () => {
    type Levels = {
      version: number;
      items: {
        id: string;
        name: string;
        minDays: number | null;
        maxDays: number | null;
        color: string;
        notify: boolean;
      }[];
    };
    const initial = (await call('/store/expiry-levels')).json() as Levels;
    expect(initial.version).toBe(1);
    expect(
      initial.items.map(({ name, minDays, maxDays, notify }) => [name, minDays, maxDays, notify]),
    ).toEqual([
      ['Vencido', null, -1, true],
      ['Urgente', 0, 5, true],
      ['Atenção', 6, 15, true],
      ['Em dia', 16, null, false],
    ]);
    const [expired, urgent, , ok] = initial.items;
    const duplicate = await call('/store/expiry-levels', 'PUT', {
      expectedVersion: 1,
      levels: [
        { ...expired, id: expired!.id },
        { ...urgent, maxDays: 10 },
        { name: 'Crítico', minDays: 8, maxDays: 10, color: '#000000', notify: true },
      ],
    });
    expect(duplicate.statusCode).toBe(422);
    expect(duplicate.json()).toMatchObject({ code: 'DUPLICATE_LEVEL_LIMIT' });

    const saved = await call('/store/expiry-levels', 'PUT', {
      expectedVersion: 1,
      levels: [
        expired,
        { ...urgent, name: 'Crítico', maxDays: 2, color: '#B71C1C' },
        { name: 'Urgente', minDays: 3, maxDays: 7, color: '#ef6c00', notify: true },
        { ...ok, minDays: 30 },
      ],
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const levels = saved.json() as Levels;
    expect(levels.version).toBe(2);
    expect(
      levels.items.map(({ name, minDays, maxDays, color }) => [name, minDays, maxDays, color]),
    ).toEqual([
      ['Vencido', null, -1, '#c62828'],
      ['Crítico', 0, 2, '#b71c1c'],
      ['Urgente', 3, 7, '#ef6c00'],
      ['Em dia', 8, null, '#2e7d32'],
    ]);
    // O nível que ficou mantém o id; o que saiu (Atenção) deixa de existir.
    expect(levels.items[1]!.id).toBe(urgent!.id);
    expect(levels.items.some((level) => level.id === initial.items[2]!.id)).toBe(false);
    // O intervalo derivado é persistido: SQL, coletor e painel leem a mesma faixa.
    const persisted = await admin.query(
      'SELECT min_days FROM expiry_levels WHERE store_id=$1 AND id=$2',
      [storeId, ok!.id],
    );
    expect(persisted.rows[0].min_days).toBe(8);

    const stale = await call('/store/expiry-levels', 'PUT', { expectedVersion: 1, levels: [] });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: 'VERSION_CONFLICT' });

    // Faixa sem nível aparece nas validades e no resumo só quando há lote nela.
    const summary = (await call('/inventory/expiries/summary')).json() as {
      items: { levelId: string | null; name: string }[];
    };
    expect(summary.items.map((item) => item.name)).toEqual([
      'Vencido',
      'Crítico',
      'Urgente',
      'Em dia',
    ]);
  });
});
