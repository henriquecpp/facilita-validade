import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/bootstrap/app.js';
import { ArgonJwtCrypto } from '../../src/modules/identity/adapters/out/identity-crypto.js';
import { PagonetClient } from '../../src/modules/integration/adapters/out/pagonet-client.js';
import { PagonetSync } from '../../src/modules/integration/adapters/out/pagonet-sync.js';
import { Jobs } from '../../src/shared/infrastructure/jobs.js';
import { testCnpj } from '../support/cnpj.js';

const SECRET = 'platform-test-secret-with-at-least-32-bytes';
const ORIGIN = 'http://localhost:5174';
const COOKIE = '__Host-estoque_platform';

describe('Painel da plataforma (super admin), com Prisma, RLS e papéis reais', () => {
  const admin = { id: randomUUID(), username: 'operacao.plataforma' };
  const temporary = 'ProvisoriaPlataforma!26';
  const password = 'SenhaDaPlataforma!2026';
  // Loja que já existe, com proprietário e operador, para suspender e recuperar acesso.
  const other = { id: randomUUID(), cnpj: testCnpj(), owner: randomUUID(), operator: randomUUID() };
  const otherPassword = 'SenhaDaLojaExistente!26';
  const created: string[] = [];
  let pool: Pool, jobs: Jobs, ctx: Awaited<ReturnType<typeof createApp>>;
  let cookie = '';

  function platform(
    method: InjectOptions['method'],
    url: string,
    body?: unknown,
    options: { cookie?: string | null; origin?: string | null; bearer?: string } = {},
  ) {
    const session = options.cookie === undefined ? cookie : options.cookie;
    return ctx.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        ...(options.origin === null
          ? {}
          : { origin: options.origin ?? ORIGIN, 'x-csrf-protection': '1' }),
        ...(session ? { cookie: `${COOKIE}=${session}` } : {}),
        ...(options.bearer ? { authorization: `Bearer ${options.bearer}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      payload: body ? JSON.stringify(body) : undefined,
    });
  }
  async function login(username: string, secret: string) {
    return platform(
      'POST',
      '/platform/auth/login',
      { username, password: secret },
      { cookie: null },
    );
  }
  async function storeLogin(cnpj: string, username: string, secret: string) {
    return ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mobile/login',
      payload: { cnpj, username, password: secret },
    });
  }
  const storeMe = (token: string) =>
    ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
  const storeAudit = async (storeId: string) =>
    (
      await pool.query<{ action: string; detail: Record<string, unknown> }>(
        // Só as ações da plataforma: logins da loja também vão para o histórico dela.
        "SELECT action, detail FROM audit_events WHERE store_id = $1 AND action LIKE 'PLATFORM\\_%' ORDER BY created_at",
        [storeId],
      )
    ).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    const crypto = new ArgonJwtCrypto(SECRET);
    await pool.query(
      'INSERT INTO platform.admins(id, username, username_normalized, password_hash) VALUES ($1, $2, $2, $3)',
      [admin.id, admin.username, await crypto.hashPassword(temporary)],
    );
    await pool.query('INSERT INTO stores(id, cnpj_normalized, name) VALUES ($1, $2, $3)', [
      other.id,
      other.cnpj,
      'Loja Existente',
    ]);
    await pool.query('INSERT INTO store_settings(store_id) VALUES ($1)', [other.id]);
    const hash = await crypto.hashPassword(otherPassword);
    for (const [id, name, role] of [
      [other.owner, 'dona', 'OWNER'],
      [other.operator, 'repositor', 'OPERATOR'],
    ])
      await pool.query(
        'INSERT INTO store_users(id, store_id, username, username_normalized, password_hash, role, must_change_password) VALUES ($1, $2, $3, $3, $4, $5, false)',
        [id, other.id, name, hash, role],
      );
    jobs = new Jobs();
    await jobs.start();
    ctx = await createApp({
      jobs,
      jwtSecret: SECRET,
      notificationChannels: [],
      // Sem PAGONET_TOKEN: a plataforma mostra a leitura como não configurada.
      pagonet: (prisma, queue, integration) =>
        new PagonetSync(
          prisma,
          queue,
          integration,
          new PagonetClient('http://127.0.0.1:9', 1000),
          null,
        ),
    });
  });

  afterAll(async () => {
    await ctx?.app.close();
    await jobs?.stop();
    if (pool) {
      for (const storeId of [other.id, ...created]) {
        for (const table of [
          'import_batches',
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
          await pool.query(`DELETE FROM ${table} WHERE store_id = $1`, [storeId]);
        await pool.query('DELETE FROM stores WHERE id = $1', [storeId]);
      }
      await pool.query('DELETE FROM platform.events');
      await pool.query('DELETE FROM platform.sessions');
      await pool.query('DELETE FROM platform.admins');
      await pool.end();
    }
    await ctx?.prisma.close();
    await ctx?.database.close();
  });

  it('entra com a senha provisória e, antes de tudo, troca a senha', async () => {
    const forged = await platform(
      'POST',
      '/platform/auth/login',
      { username: admin.username, password: temporary },
      { cookie: null, origin: null },
    );
    expect(forged.statusCode).toBe(403);
    expect(forged.json().code).toBe('CSRF_REJECTED');
    expect((await login(admin.username, 'SenhaErrada!2026')).statusCode).toBe(401);
    expect((await login('ninguem', temporary)).json().code).toBe('INVALID_CREDENTIALS');

    const response = await login(admin.username, temporary);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      id: admin.id,
      username: admin.username,
      mustChangePassword: true,
    });
    expect(response.headers['cache-control']).toBe('no-store');
    const issued = response.cookies.find((item) => item.name === COOKIE);
    expect(issued).toMatchObject({ httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
    cookie = issued!.value;

    expect((await platform('GET', '/platform/me')).json()).toMatchObject({
      mustChangePassword: true,
    });
    const blocked = await platform('GET', '/platform/stores');
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().code).toBe('PASSWORD_CHANGE_REQUIRED');

    const wrong = await platform('POST', '/platform/auth/change-password', {
      currentPassword: 'NaoEhEssa!2026',
      newPassword: password,
    });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().code).toBe('CURRENT_PASSWORD_INVALID');
    const same = await platform('POST', '/platform/auth/change-password', {
      currentPassword: temporary,
      newPassword: temporary,
    });
    expect(same.statusCode).toBe(400);
    const changed = await platform('POST', '/platform/auth/change-password', {
      currentPassword: temporary,
      newPassword: password,
    });
    expect(changed.statusCode, changed.body).toBe(200);
    expect(changed.json()).toMatchObject({ mustChangePassword: false });
    // A sessão atual continua valendo.
    expect((await platform('GET', '/platform/stores')).statusCode).toBe(200);
  });

  it('cadastra a loja com o proprietário; o CNPJ não se repete', async () => {
    const cnpj = testCnpj();
    const response = await platform('POST', '/platform/stores', {
      cnpj,
      name: '  Mercado   Novo  ',
      ownerUsername: 'Dono.Novo',
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    const body = response.json() as {
      store: { id: string; name: string; cnpj: string; active: boolean; owners: string[] };
      owner: { username: string; temporaryPassword: string };
    };
    created.push(body.store.id);
    expect(body.store).toMatchObject({
      name: 'Mercado Novo',
      cnpj,
      active: true,
      owners: ['Dono.Novo'],
      activeUsers: 1,
      pagonet: null,
    });
    expect(body.owner.temporaryPassword).toMatch(/^[A-Za-z0-9]{4}(-[A-Za-z0-9]{4}){3}$/);

    // O proprietário entra com a senha provisória e precisa trocá-la.
    const owner = await storeLogin(cnpj, 'dono.novo', body.owner.temporaryPassword);
    expect(owner.statusCode, owner.body).toBe(200);
    expect(owner.json().mustChangePassword).toBe(true);

    const repeated = await platform('POST', '/platform/stores', {
      cnpj,
      name: 'Outra',
      ownerUsername: 'outro',
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json().code).toBe('STORE_EXISTS');
    expect(
      (
        await platform('POST', '/platform/stores', {
          cnpj: '11.111.111/1111-11',
          name: 'X',
          ownerUsername: 'dono',
        })
      ).json().code,
    ).toBe('INVALID_CNPJ');

    // No histórico da loja, com quem fez; sem a senha.
    const audit = await storeAudit(body.store.id);
    expect(audit).toEqual([
      {
        action: 'PLATFORM_STORE_PROVISIONED',
        detail: { operator: admin.username, adminId: admin.id, username: 'dono.novo', cnpj },
      },
    ]);
    const list = (await platform('GET', '/platform/stores')).json() as {
      items: { id: string; owners: string[] }[];
    };
    expect(list.items.find((store) => store.id === body.store.id)?.owners).toEqual(['Dono.Novo']);
    expect(list.items.find((store) => store.id === other.id)).toMatchObject({
      name: 'Loja Existente',
      activeUsers: 2,
      owners: ['dona'],
    });
  });

  it('suspensa, a loja para na hora: sessões, login, integração e worker; reativada, volta', async () => {
    const before = await storeLogin(other.cnpj, 'dona', otherPassword);
    const token = before.json().accessToken as string;
    expect((await storeMe(token)).statusCode).toBe(200);

    expect((await platform('POST', `/platform/stores/${other.id}/suspend`, {})).statusCode).toBe(
      400,
    );
    const suspended = await platform('POST', `/platform/stores/${other.id}/suspend`, {
      reason: 'Contrato encerrado',
    });
    expect(suspended.statusCode, suspended.body).toBe(200);
    expect(suspended.json()).toMatchObject({ active: false });
    // De novo: nada muda, nem o histórico.
    await platform('POST', `/platform/stores/${other.id}/suspend`, { reason: 'Repetido' });

    expect((await storeMe(token)).statusCode).toBe(401);
    expect((await storeLogin(other.cnpj, 'dona', otherPassword)).statusCode).toBe(401);
    const active = await pool.query('SELECT id FROM auth.active_store_ids() WHERE id = $1', [
      other.id,
    ]);
    expect(active.rowCount).toBe(0);
    const access = await platform('POST', `/platform/stores/${other.id}/owner-access`, {
      userId: other.owner,
      reason: 'Esqueceu a senha',
    });
    expect(access.statusCode).toBe(409);
    expect(access.json().code).toBe('STORE_SUSPENDED');

    const back = await platform('POST', `/platform/stores/${other.id}/reactivate`, {
      reason: 'Contrato renovado',
    });
    expect(back.json()).toMatchObject({ active: true });
    expect((await storeMe(token)).statusCode).toBe(200);
    expect(
      (await storeAudit(other.id)).map((event) => [event.action, event.detail.reason]),
    ).toEqual([
      ['PLATFORM_STORE_SUSPENDED', 'Contrato encerrado'],
      ['PLATFORM_STORE_REACTIVATED', 'Contrato renovado'],
    ]);
  });

  it('acesso novo para o proprietário: link de uso único, senha e sessões anteriores encerradas', async () => {
    const session = (await storeLogin(other.cnpj, 'dona', otherPassword)).json();
    const notOwner = await platform('POST', `/platform/stores/${other.id}/owner-access`, {
      userId: other.operator,
      reason: 'Tentativa com operador',
    });
    expect(notOwner.statusCode).toBe(404);
    expect(notOwner.json().code).toBe('OWNER_NOT_FOUND');
    expect(
      (
        await platform('POST', `/platform/stores/${randomUUID()}/owner-access`, {
          userId: other.owner,
          reason: 'Loja que não existe',
        })
      ).json().code,
    ).toBe('STORE_NOT_FOUND');

    const response = await platform('POST', `/platform/stores/${other.id}/owner-access`, {
      userId: other.owner,
      reason: 'Proprietária perdeu a senha',
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    const { resetToken, username } = response.json() as { resetToken: string; username: string };
    expect(username).toBe('dona');
    expect((await storeMe(session.accessToken)).statusCode).toBe(401);
    expect((await storeLogin(other.cnpj, 'dona', otherPassword)).statusCode).toBe(401);

    const fresh = 'NovaSenhaDaDona!2026';
    const reset = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/complete-password-reset',
      payload: { token: resetToken, newPassword: fresh },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    expect((await storeLogin(other.cnpj, 'dona', fresh)).statusCode).toBe(200);
    // Uso único.
    const again = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/complete-password-reset',
      payload: { token: resetToken, newPassword: 'OutraSenhaQualquer!26' },
    });
    expect(again.statusCode).toBe(401);
    // O histórico guarda o motivo, nunca o link.
    const audit = await storeAudit(other.id);
    expect(audit.at(-1)).toMatchObject({
      action: 'PLATFORM_OWNER_RESET_ISSUED',
      detail: { operator: admin.username, reason: 'Proprietária perdeu a senha', username: 'dona' },
    });
    expect(JSON.stringify(audit)).not.toContain(resetToken);
  });

  it('histórico reúne as ações da plataforma e as feitas nas lojas, sem segredos', async () => {
    const page = (await platform('GET', '/platform/history?limit=100')).json() as {
      items: {
        id: string;
        action: string;
        operator: string | null;
        store: { id: string; name: string } | null;
        detail: Record<string, string>;
      }[];
    };
    // O banco dos testes é compartilhado: só as ações deste arquivo.
    const ours = page.items.filter(
      (item) => item.store === null || [other.id, ...created].includes(item.store.id),
    );
    const actions = ours.map((item) => item.action);
    for (const action of [
      'PLATFORM_LOGIN',
      'PLATFORM_PASSWORD_CHANGED',
      'PLATFORM_STORE_PROVISIONED',
      'PLATFORM_STORE_SUSPENDED',
      'PLATFORM_STORE_REACTIVATED',
      'PLATFORM_OWNER_RESET_ISSUED',
    ])
      expect(actions).toContain(action);
    expect(ours.every((item) => item.operator === admin.username)).toBe(true);
    expect(ours.find((item) => item.action === 'PLATFORM_STORE_SUSPENDED')).toMatchObject({
      store: { name: 'Loja Existente' },
      detail: { reason: 'Contrato encerrado' },
    });
    // Só os campos conhecidos saem do detalhe: nada de adminId.
    expect(JSON.stringify(page.items)).not.toContain('adminId');

    const first = (await platform('GET', '/platform/history?limit=2')).json();
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBe(first.items[1].id);
    const second = (
      await platform('GET', `/platform/history?limit=2&cursor=${first.nextCursor}`)
    ).json();
    expect(second.items[0].id).toBe(page.items[2]!.id);
  });

  it('identidades separadas: token de loja não abre a plataforma, nem o cookie dela abre lojas', async () => {
    const owner = (await storeLogin(other.cnpj, 'dona', 'NovaSenhaDaDona!2026')).json();
    expect(
      (
        await platform('GET', '/platform/stores', undefined, {
          cookie: null,
          bearer: owner.accessToken,
        })
      ).statusCode,
    ).toBe(401);
    const storeRoute = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { cookie: `${COOKIE}=${cookie}` },
    });
    expect(storeRoute.statusCode).toBe(401);
    // Escrita com o cookie, mas sem a origem do painel: recusada antes de tudo.
    for (const origin of [null, 'https://outro-site.example'])
      expect(
        (
          await platform(
            'POST',
            `/platform/stores/${other.id}/suspend`,
            { reason: 'Ataque CSRF' },
            { origin },
          )
        ).json().code,
      ).toBe('CSRF_REJECTED');
    expect((await platform('GET', `/platform/stores/${other.id}`)).json().active).toBe(true);
  });

  it('no banco, só as funções da plataforma: o runtime das lojas nem enxerga o schema', async () => {
    const runtime = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
    const auth = new Pool({ connectionString: process.env.AUTH_DATABASE_URL, max: 1 });
    try {
      for (const query of ['SELECT * FROM platform.admins', 'SELECT * FROM platform.stores()'])
        await expect(runtime.query(query)).rejects.toThrow(/permission denied/);
      await expect(auth.query('SELECT * FROM platform.admins')).rejects.toThrow(
        /permission denied/,
      );
      await expect(auth.query('SELECT password_hash FROM store_users')).rejects.toThrow(
        /permission denied/,
      );
      const stores = await auth.query('SELECT id FROM platform.stores()');
      expect(stores.rowCount).toBeGreaterThan(0);
    } finally {
      await runtime.end();
      await auth.end();
    }
  });

  it('última importação é o fim do processamento do lote mais recente, como no painel da loja', async () => {
    const connection = randomUUID();
    await pool.query(
      "INSERT INTO integration_connections(id, store_id, name) VALUES ($1, $2, 'Teste da plataforma')",
      [connection, other.id],
    );
    // Um lote concluído há uma hora e outro que acabou de chegar e ainda não foi processado.
    await pool.query(
      `INSERT INTO import_batches(id, store_id, connection_id, external_batch_id, payload_hash, kind,
                                  status, payload, created_at, completed_at)
       VALUES ($1, $3, $4, 'lote-concluido', 'h1', 'MOVEMENTS', 'COMPLETED', '{}'::jsonb,
               clock_timestamp() - interval '2 hours', clock_timestamp() - interval '1 hour'),
              ($2, $3, $4, 'lote-novo', 'h2', 'MOVEMENTS', 'RECEIVED', '{}'::jsonb,
               clock_timestamp(), NULL)`,
      [randomUUID(), randomUUID(), other.id, connection],
    );
    const completed = (
      await pool.query<{ at: Date }>(
        "SELECT completed_at AS at FROM import_batches WHERE store_id = $1 AND external_batch_id = 'lote-concluido'",
        [other.id],
      )
    ).rows[0]!.at.toISOString();
    const list = (await platform('GET', '/platform/stores')).json() as {
      items: { id: string; lastImportAt: string | null }[];
    };
    expect(list.items.find((store) => store.id === other.id)?.lastImportAt).toBe(completed);
    expect((await platform('GET', `/platform/stores/${other.id}`)).json().lastImportAt).toBe(
      completed,
    );
  });

  it('Pagonet sem token na aplicação aparece como não configurada', async () => {
    expect((await platform('GET', '/platform/pagonet')).json()).toEqual({ configured: false });
    expect((await platform('POST', '/platform/pagonet/check')).json()).toMatchObject({
      configured: false,
      ok: false,
    });
  });

  it('sessão vencida ou encerrada não vale; tentativas demais esperam um minuto', async () => {
    await pool.query(
      "UPDATE platform.sessions SET created_at = created_at - interval '9 hours', expires_at = clock_timestamp() - interval '1 minute' WHERE admin_id = $1",
      [admin.id],
    );
    expect((await platform('GET', '/platform/me')).statusCode).toBe(401);

    cookie = (await login(admin.username, password)).cookies.find(
      (item) => item.name === COOKIE,
    )!.value;
    expect((await platform('GET', '/platform/me')).statusCode).toBe(200);
    const out = await platform('POST', '/platform/auth/logout');
    expect(out.json()).toEqual({ loggedOut: true });
    expect((await platform('GET', '/platform/me')).statusCode).toBe(401);

    const attempts = [];
    for (let i = 0; i < 6; i++) attempts.push((await login('tentativa.repetida', 'x')).statusCode);
    expect(attempts).toEqual([401, 401, 401, 401, 401, 429]);
  });
});
