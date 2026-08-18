import { createHash, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Database } from '../../src/shared/infrastructure/database.js';
import { createAuthService } from '../../src/modules/identity/composition.js';
import { ArgonJwtCrypto } from '../../src/modules/identity/adapters/out/identity-crypto.js';
import { createApp } from '../../src/bootstrap/app.js';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../../src/generated/prisma/client.js';
import { PrismaDatabase } from '../../src/shared/infrastructure/prisma.js';
import { SESSION_OPTIONS } from '../../src/shared/infrastructure/database.js';
import { sqlState } from '../../src/shared/infrastructure/database-errors.js';
import { PrismaIdentityAdmin } from '../../src/modules/identity/adapters/out/prisma-identity-admin.js';
import type { AuthService } from '../../src/modules/identity/application/auth-service.js';
import type { TenantActor } from '../../src/shared/domain/context.js';
import { testCnpj } from '../support/cnpj.js';

const enabled = process.env.RUN_IDENTITY_DB_TESTS === '1';
describe.skipIf(!enabled)('Identidade com PostgreSQL e papéis RLS reais', () => {
  const storeIds = [randomUUID(), randomUUID()];
  const userIds = [randomUUID(), randomUUID()];
  const cnpjs: string[] = [];
  const password = 'SenhaDeTeste!2026';
  let database: Database, prisma: PrismaDatabase, admin: Pool, adminClient: PrismaClient;
  let auth: AuthService, administration: PrismaIdentityAdmin;
  let server: Awaited<ReturnType<typeof createApp>> | undefined;
  beforeAll(async () => {
    if (
      !process.env.DATABASE_URL ||
      !process.env.AUTH_DATABASE_URL ||
      !process.env.MIGRATION_DATABASE_URL
    )
      throw new Error(
        'Configure as três URLs do PostgreSQL para executar os testes de identidade.',
      );
    database = new Database();
    prisma = new PrismaDatabase(database);
    admin = new Pool({
      connectionString: process.env.MIGRATION_DATABASE_URL,
      options: SESSION_OPTIONS,
    });
    adminClient = new PrismaClient({ adapter: new PrismaPg(admin) });
    administration = new PrismaIdentityAdmin(adminClient);
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('WEB_ORIGIN', 'https://estoque.example.test');
    auth = createAuthService(prisma, 'identity-test-secret-of-at-least-thirty-two-bytes');
    const passwordHash = await new ArgonJwtCrypto(
      'identity-test-secret-of-at-least-thirty-two-bytes',
    ).hashPassword(password);
    for (let index = 0; index < 2; index++) {
      const cnpj = testCnpj();
      cnpjs.push(cnpj);
      await admin.query('INSERT INTO stores(id,cnpj_normalized,name) VALUES($1,$2,$3)', [
        storeIds[index],
        cnpj,
        `Identity Test ${index}`,
      ]);
      await admin.query(
        "INSERT INTO store_users(id,store_id,username,username_normalized,password_hash,role,must_change_password) VALUES($1,$2,'admin','admin',$3,'OWNER',false)",
        [userIds[index], storeIds[index], passwordHash],
      );
    }
  });
  afterAll(async () => {
    await server?.app.close();
    await server?.jobs.stop();
    if (admin) {
      for (const table of [
        'audit_events',
        'refresh_tokens',
        'password_reset_tokens',
        'push_subscriptions',
        'auth_sessions',
        'store_users',
        'expiry_levels',
        'store_settings',
      ])
        await admin.query(`DELETE FROM ${table} WHERE store_id=ANY($1::uuid[])`, [storeIds]);
      await admin.query('DELETE FROM stores WHERE id=ANY($1::uuid[])', [storeIds]);
      await adminClient?.$disconnect();
      await admin.end();
    }
    await prisma?.close();
    await database?.close();
    vi.unstubAllEnvs();
  });
  async function owner(): Promise<TenantActor> {
    return auth.authenticate(
      (await auth.login({ cnpj: cnpjs[0]!, username: 'ADMIN', password }, 'mobile')).accessToken,
    );
  }
  it('resolve mesmo usuário em duas lojas e oculta linhas sem contexto', async () => {
    const first = await auth.login({ cnpj: cnpjs[0]!, username: 'admin', password }, 'mobile');
    const second = await auth.login({ cnpj: cnpjs[1]!, username: 'admin', password }, 'mobile');
    expect(first.user.storeId).toBe(storeIds[0]);
    expect(second.user.storeId).toBe(storeIds[1]);
    expect((await database.pool.query('SELECT id FROM store_users')).rows).toEqual([]);
    await expect(database.auth.query('SELECT id FROM store_users')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(
      auth.updateUser(await auth.authenticate(first.accessToken), userIds[1]!, {
        expectedVersion: 1,
        active: false,
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
  it('retorna o mesmo erro para login desconhecido, senha errada e CNPJ inválido', async () => {
    for (const input of [
      { cnpj: cnpjs[0]!, username: 'missing', password },
      { cnpj: cnpjs[0]!, username: 'admin', password: 'SenhaIncorreta' },
      { cnpj: 'invalid', username: 'admin', password },
    ])
      await expect(auth.login(input, 'mobile')).rejects.toMatchObject({
        code: 'INVALID_CREDENTIALS',
        status: 401,
      });
  });
  it('rota refresh, aceita de novo o token cuja resposta se perdeu e revoga se a cadeia andou', async () => {
    const first = await auth.login({ cnpj: cnpjs[0]!, username: 'admin', password }, 'mobile');
    // A resposta desta troca se perde no Wi-Fi: o coletor tenta de novo com o mesmo token.
    const lost = await auth.refresh(first.refreshToken!, 'mobile');
    expect(lost.refreshToken).not.toBe(first.refreshToken);
    const retried = await auth.refresh(first.refreshToken!, 'mobile');
    expect(retried.refreshToken).not.toBe(lost.refreshToken);
    await expect(auth.authenticate(retried.accessToken)).resolves.toMatchObject({
      sessionId: expect.any(String),
    });
    // O novo segue a cadeia.
    const next = await auth.refresh(retried.refreshToken!, 'mobile');
    // Com a cadeia já adiante, o token antigo é reúso: a família inteira cai.
    await expect(auth.refresh(first.refreshToken!, 'mobile')).rejects.toMatchObject({
      status: 401,
    });
    await expect(auth.authenticate(next.accessToken)).rejects.toMatchObject({ status: 401 });
    await expect(auth.refresh(next.refreshToken!, 'mobile')).rejects.toMatchObject({
      status: 401,
    });
  });
  it('não permite consumir refresh mobile pela rota web', async () => {
    const first = await auth.login({ cnpj: cnpjs[0]!, username: 'admin', password }, 'mobile');
    await expect(auth.refresh(first.refreshToken!, 'web')).rejects.toMatchObject({ status: 401 });
    await expect(auth.refresh(first.refreshToken!, 'mobile')).resolves.toHaveProperty(
      'accessToken',
    );
  });
  it('impede desativar o último proprietário e protege expectedVersion', async () => {
    const actor = await owner();
    await expect(
      auth.updateUser(actor, actor.userId, { expectedVersion: 1, active: false }),
    ).rejects.toMatchObject({ code: 'LAST_OWNER' });
    await expect(
      auth.updateUser(actor, actor.userId, { expectedVersion: 500, username: 'novo' }),
    ).rejects.toMatchObject({ code: 'VERSION_CONFLICT' });
  });
  it('restringe senha provisória, troca e exige novo login', async () => {
    const created = await auth.createUser(await owner(), {
      username: 'operador',
      temporaryPassword: password,
      role: 'OPERATOR',
    });
    const first = await auth.login({ cnpj: cnpjs[0]!, username: 'operador', password }, 'mobile');
    expect(first.refreshToken).toBeUndefined();
    expect(first.mustChangePassword).toBe(true);
    const actor = await auth.authenticate(first.accessToken);
    expect(actor.restricted).toBe(true);
    await expect(auth.users(actor)).rejects.toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    expect((await auth.me(actor)).user.id).toBe(created.id);
    // Senha atual errada é erro do formulário (422), não sessão vencida (401): com 401 o
    // painel e o coletor tentariam renovar a sessão provisória, que não tem renovação.
    await expect(
      auth.changePassword(actor, 'SenhaAtualErrada!2026', 'NovaSenhaDoOperador!2026'),
    ).rejects.toMatchObject({ code: 'CURRENT_PASSWORD_INVALID', status: 422 });
    expect((await auth.me(actor)).user.id).toBe(created.id);
    await auth.changePassword(actor, password, 'NovaSenhaDoOperador!2026');
    await expect(auth.authenticate(first.accessToken)).rejects.toMatchObject({ status: 401 });
    const changed = await auth.login(
      { cnpj: cnpjs[0]!, username: 'operador', password: 'NovaSenhaDoOperador!2026' },
      'mobile',
    );
    expect(changed.refreshToken).toBeDefined();
    expect(changed.mustChangePassword).toBe(false);
  });
  it('reset invalida senha anterior e só pode ser concluído uma vez', async () => {
    const actor = await owner();
    const created = await auth.createUser(actor, {
      username: 'reset-user',
      temporaryPassword: password,
      role: 'MANAGER',
    });
    const reset = await auth.resetPassword(actor, created.id);
    await expect(
      auth.login({ cnpj: cnpjs[0]!, username: 'reset-user', password }, 'mobile'),
    ).rejects.toMatchObject({ status: 401 });
    await auth.completePasswordReset(reset.resetToken, 'SenhaRecuperada!2026');
    await expect(
      auth.completePasswordReset(reset.resetToken, 'OutraSenha!2026'),
    ).rejects.toMatchObject({ status: 401, code: 'RESET_LINK_INVALID' });
    const recovered = await auth.login(
      { cnpj: cnpjs[0]!, username: 'reset-user', password: 'SenhaRecuperada!2026' },
      'mobile',
    );
    expect(recovered.mustChangePassword).toBe(false);
  });
  it('não permite privilégios administrativos nem preserva contexto no pool', async () => {
    const role = (
      await database.pool.query(
        'SELECT rolsuper,rolbypassrls,rolcreaterole,rolcreatedb FROM pg_roles WHERE rolname=current_user',
      )
    ).rows[0];
    expect(role).toEqual({
      rolsuper: false,
      rolbypassrls: false,
      rolcreaterole: false,
      rolcreatedb: false,
    });
    await prisma.tenant(storeIds[0]!, async (tx) =>
      expect((await tx.store_users.findMany({ select: { id: true } })).length).toBeGreaterThan(0),
    );
    // A loja fixada na transação não sobra na conexão devolvida ao pool compartilhado.
    expect(await prisma.runtime.store_users.findMany({ select: { id: true } })).toEqual([]);
    expect((await database.pool.query('SELECT id FROM store_users')).rows).toEqual([]);
    await expect(
      database.pool.query('SELECT * FROM auth.resolve_login($1,$2)', [cnpjs[0], 'admin']),
    ).rejects.toMatchObject({ code: '42501' });
  });
  it('serializa refresh simultâneo: a segunda é nova tentativa e só o último token vale', async () => {
    const initial = await auth.login({ cnpj: cnpjs[0]!, username: 'admin', password }, 'mobile');
    const results = await Promise.all([
      auth.refresh(initial.refreshToken!, 'mobile'),
      auth.refresh(initial.refreshToken!, 'mobile'),
    ]);
    // Duas abas do painel: o cookie que fica pode ser o de qualquer resposta, e ambos valem.
    for (const result of results)
      await expect(auth.authenticate(result.accessToken)).resolves.toMatchObject({
        sessionId: expect.any(String),
      });
    for (const result of results)
      await expect(auth.refresh(result.refreshToken!, 'mobile')).resolves.toHaveProperty(
        'accessToken',
      );
  });
  it('logout revoga somente a sessão correspondente e respeita o cliente', async () => {
    const first = await auth.login({ cnpj: cnpjs[0]!, username: 'admin', password }, 'mobile');
    const other = await auth.login({ cnpj: cnpjs[0]!, username: 'admin', password }, 'mobile');
    await auth.logout(first.refreshToken, first.accessToken, 'web');
    await expect(auth.authenticate(first.accessToken)).resolves.toHaveProperty('userId');
    await auth.logout(first.refreshToken, first.accessToken, 'mobile');
    await expect(auth.authenticate(first.accessToken)).rejects.toMatchObject({ status: 401 });
    await expect(auth.refresh(first.refreshToken!, 'mobile')).rejects.toMatchObject({
      status: 401,
    });
    await expect(auth.authenticate(other.accessToken)).resolves.toHaveProperty('userId');
  });
  it('rejeita sessões vencidas e suspensão da loja mesmo com JWT ainda válido', async () => {
    const session = await auth.login({ cnpj: cnpjs[1]!, username: 'admin', password }, 'mobile');
    const actor = await auth.authenticate(session.accessToken);
    await admin.query(
      "UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
      [actor.sessionId],
    );
    await expect(auth.authenticate(session.accessToken)).rejects.toMatchObject({ status: 401 });
    await expect(auth.refresh(session.refreshToken!, 'mobile')).rejects.toMatchObject({
      status: 401,
    });
    const active = await auth.login({ cnpj: cnpjs[1]!, username: 'admin', password }, 'mobile');
    await admin.query('UPDATE stores SET active=false WHERE id=$1', [storeIds[1]]);
    try {
      await expect(auth.authenticate(active.accessToken)).rejects.toMatchObject({ status: 401 });
      await expect(auth.refresh(active.refreshToken!, 'mobile')).rejects.toMatchObject({
        status: 401,
      });
      await expect(
        auth.login({ cnpj: cnpjs[1]!, username: 'admin', password }, 'mobile'),
      ).rejects.toMatchObject({ code: 'INVALID_CREDENTIALS' });
    } finally {
      await admin.query('UPDATE stores SET active=true WHERE id=$1', [storeIds[1]]);
    }
  });
  it('revoga sessões ao mudar papel ou desativar usuário', async () => {
    const actor = await owner();
    const user = await auth.createUser(actor, {
      username: 'role-change',
      temporaryPassword: password,
      role: 'MANAGER',
    });
    const provisional = await auth.login(
      { cnpj: cnpjs[0]!, username: user.username, password },
      'mobile',
    );
    await auth.changePassword(
      await auth.authenticate(provisional.accessToken),
      password,
      'SenhaPermanente!2026',
    );
    const active = await auth.login(
      { cnpj: cnpjs[0]!, username: user.username, password: 'SenhaPermanente!2026' },
      'mobile',
    );
    const updated = await auth.updateUser(actor, user.id, { expectedVersion: 2, role: 'OPERATOR' });
    await expect(auth.authenticate(active.accessToken)).rejects.toMatchObject({ status: 401 });
    const operator = await auth.login(
      { cnpj: cnpjs[0]!, username: user.username, password: 'SenhaPermanente!2026' },
      'mobile',
    );
    expect((await auth.authenticate(operator.accessToken)).role).toBe('OPERATOR');
    await expect(auth.users(await auth.authenticate(operator.accessToken))).rejects.toMatchObject({
      status: 403,
    });
    await auth.updateUser(actor, user.id, { expectedVersion: updated.version, active: false });
    await expect(auth.authenticate(operator.accessToken)).rejects.toMatchObject({ status: 401 });
    await expect(
      auth.login(
        { cnpj: cnpjs[0]!, username: user.username, password: 'SenhaPermanente!2026' },
        'mobile',
      ),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('novo reset invalida o anterior e consumo concorrente só conclui uma vez', async () => {
    const actor = await owner();
    const user = await auth.createUser(actor, {
      username: 'reset-concurrent',
      temporaryPassword: password,
      role: 'OPERATOR',
    });
    const first = await auth.resetPassword(actor, user.id),
      second = await auth.resetPassword(actor, user.id);
    await expect(
      auth.completePasswordReset(first.resetToken, 'NovaSenhaReset!2026'),
    ).rejects.toMatchObject({ status: 401 });
    const results = await Promise.allSettled([
      auth.completePasswordReset(second.resetToken, 'NovaSenhaReset!2026'),
      auth.completePasswordReset(second.resetToken, 'NovaSenhaReset!2026'),
    ]);
    expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((value) => value.status === 'rejected')).toHaveLength(1);
    const expired = await auth.resetPassword(actor, user.id);
    await admin.query(
      "UPDATE password_reset_tokens SET expires_at=clock_timestamp()-interval '1 second' WHERE token_hash=$1",
      [createHash('sha256').update(expired.resetToken).digest('hex')],
    );
    await expect(
      auth.completePasswordReset(expired.resetToken, 'NovaSenhaReset!2026'),
    ).rejects.toMatchObject({ status: 401 });
  });
  it('provisiona CNPJ alfanumérico sem sobrescrever credenciais em repetição', async () => {
    const input = {
      cnpj: '12ABC34501DE35',
      storeName: 'Loja Alfanumérica',
      username: 'PrimeiroOwner',
      temporaryPassword: password,
      operator: 'teste-administrativo',
    };
    const created = await administration.provision(input);
    storeIds.push(created.storeId);
    const repeated = await administration
      .provision({ ...input, temporaryPassword: 'NaoDeveSubstituir!2026' })
      .catch((error: unknown) => error);
    // O CLI traduz exatamente este SQLSTATE em ALREADY_EXISTS.
    expect(sqlState(repeated)).toBe('23505');
    const login = await auth.login(
      { cnpj: '12.abc.345/01de-35', username: 'primeiroowner', password },
      'mobile',
    );
    expect(login.mustChangePassword).toBe(true);
    expect(login.user.storeId).toBe(created.storeId);
    expect(
      (
        await admin.query(
          "SELECT detail FROM audit_events WHERE store_id=$1 AND action='PLATFORM_STORE_PROVISIONED'",
          [created.storeId],
        )
      ).rows,
    ).toHaveLength(1);
  });
  it('recupera OWNER por credencial administrativa auditada e de uso único', async () => {
    const cnpj = testCnpj();
    const created = await administration.provision({
      cnpj,
      storeName: 'Recuperação',
      username: 'owner',
      temporaryPassword: password,
      operator: 'teste',
    });
    storeIds.push(created.storeId);
    const initial = await auth.login({ cnpj, username: 'owner', password }, 'mobile');
    const first = await administration.recoverOwner({
      cnpj,
      username: 'owner',
      operator: 'teste',
      reason: 'Perda da senha em teste',
    });
    const second = await administration.recoverOwner({
      cnpj,
      username: 'owner',
      operator: 'teste',
      reason: 'Substituição do primeiro código',
    });
    await expect(auth.authenticate(initial.accessToken)).rejects.toMatchObject({ status: 401 });
    await expect(auth.login({ cnpj, username: 'owner', password }, 'mobile')).rejects.toMatchObject(
      { status: 401 },
    );
    await expect(
      auth.completePasswordReset(first.resetToken, 'RecuperacaoOwner!2026'),
    ).rejects.toMatchObject({ status: 401 });
    await auth.completePasswordReset(second.resetToken, 'RecuperacaoOwner!2026');
    await expect(
      auth.completePasswordReset(second.resetToken, 'RecuperacaoOwner!2026'),
    ).rejects.toMatchObject({ status: 401 });
    expect(
      (await auth.login({ cnpj, username: 'owner', password: 'RecuperacaoOwner!2026' }, 'mobile'))
        .mustChangePassword,
    ).toBe(false);
    const audit = (
      await admin.query(
        "SELECT detail FROM audit_events WHERE store_id=$1 AND action='PLATFORM_OWNER_RESET_ISSUED'",
        [created.storeId],
      )
    ).rows;
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toContain(second.resetToken);
  });
  it('protege login web com CSRF e cookie seguro sem refresh no JSON', async () => {
    server ??= await createApp({
      database,
      jwtSecret: 'identity-test-secret-of-at-least-thirty-two-bytes',
      logging: false,
    });
    const credentials = { cnpj: cnpjs[0]!, username: 'admin', password };
    const rejected = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/web/login',
      payload: credentials,
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json().code).toBe('CSRF_REJECTED');
    const login = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/web/login',
      payload: credentials,
      headers: { origin: 'https://estoque.example.test', 'x-csrf-protection': '1' },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().refreshToken).toBeUndefined();
    expect(login.headers['cache-control']).toBe('no-store');
    const cookie = String(login.headers['set-cookie']);
    for (const flag of [
      '__Host-estoque_refresh=',
      'HttpOnly',
      'Secure',
      'SameSite=Strict',
      'Path=/',
    ])
      expect(cookie).toContain(flag);
    expect(cookie).not.toContain('Domain=');
    const refresh = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/web/refresh',
      headers: {
        origin: 'https://estoque.example.test',
        'x-csrf-protection': '1',
        cookie: cookie.split(';')[0]!,
      },
    });
    expect(refresh.statusCode).toBe(200);
    expect(refresh.json().refreshToken).toBeUndefined();
    const mobileViaCookie = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mobile/refresh',
      payload: {},
      headers: { cookie: cookie.split(';')[0]! },
    });
    expect(mobileViaCookie.statusCode).toBe(400);
  });
  it('aceita cada origem listada em WEB_ORIGIN, e só elas', async () => {
    server ??= await createApp({
      database,
      jwtSecret: 'identity-test-secret-of-at-least-thirty-two-bytes',
      logging: false,
    });
    // Como em desenvolvimento: o mesmo painel por dois endereços de loopback.
    vi.stubEnv('WEB_ORIGIN', 'http://localhost:5174, http://127.0.0.1:5174');
    try {
      const attempt = (origin: string) =>
        server!.app.inject({
          method: 'POST',
          url: '/api/v1/auth/web/login',
          payload: { cnpj: cnpjs[1]!, username: 'admin', password },
          headers: { origin, 'x-csrf-protection': '1' },
        });
      expect((await attempt('http://localhost:5174')).statusCode).toBe(200);
      expect((await attempt('http://127.0.0.1:5174')).statusCode).toBe(200);
      for (const origin of ['http://127.0.0.1:5173', 'https://estoque.example.test']) {
        const rejected = await attempt(origin);
        expect(rejected.statusCode, origin).toBe(403);
        expect(rejected.json().code).toBe('CSRF_REJECTED');
      }
    } finally {
      vi.stubEnv('WEB_ORIGIN', 'https://estoque.example.test');
    }
  });
  it('barra sessão provisória nos endpoints de negócio e rejeita tenant no corpo', async () => {
    server ??= await createApp({
      database,
      jwtSecret: 'identity-test-secret-of-at-least-thirty-two-bytes',
      logging: false,
    });
    await auth.createUser(await owner(), {
      username: 'http-provisional',
      temporaryPassword: password,
      role: 'OPERATOR',
    });
    const login = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mobile/login',
      payload: { cnpj: cnpjs[0]!, username: 'http-provisional', password },
    });
    expect(login.statusCode).toBe(200);
    expect(login.json().refreshToken).toBeUndefined();
    const headers = { authorization: `Bearer ${login.json().accessToken}` };
    const denied = await server.app.inject({ method: 'GET', url: '/api/v1/users', headers });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect(
      (await server.app.inject({ method: 'GET', url: '/api/v1/me', headers })).statusCode,
    ).toBe(200);
    const unexpected = await server.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mobile/login',
      payload: { cnpj: cnpjs[0]!, username: 'admin', password, storeId: storeIds[1] },
    });
    expect(unexpected.statusCode).toBe(400);
    const ownerLogin = await auth.login({ cnpj: cnpjs[0]!, username: 'admin', password }, 'mobile');
    const nullUpdate = await server.app.inject({
      method: 'PATCH',
      url: `/api/v1/users/${ownerLogin.user.id}`,
      headers: { authorization: `Bearer ${ownerLogin.accessToken}` },
      payload: { expectedVersion: 1, username: null, role: null, active: null },
    });
    expect(nullUpdate.statusCode).toBe(400);
  });
  it('serializa alterações concorrentes para preservar pelo menos um OWNER', async () => {
    const firstActor = await owner();
    const second = await auth.createUser(firstActor, {
      username: 'owner-two',
      temporaryPassword: password,
      role: 'OWNER',
    });
    const session = await auth.login(
      { cnpj: cnpjs[0]!, username: 'owner-two', password },
      'mobile',
    );
    await auth.changePassword(
      await auth.authenticate(session.accessToken),
      password,
      'OwnerDoisSenha!2026',
    );
    const secondSession = await auth.login(
      { cnpj: cnpjs[0]!, username: 'owner-two', password: 'OwnerDoisSenha!2026' },
      'mobile',
    );
    const secondActor = await auth.authenticate(secondSession.accessToken);
    const results = await Promise.allSettled([
      auth.updateUser(firstActor, firstActor.userId, { expectedVersion: 1, role: 'MANAGER' }),
      auth.updateUser(secondActor, second.id, { expectedVersion: 2, role: 'MANAGER' }),
    ]);
    expect(results.filter((value) => value.status === 'fulfilled')).toHaveLength(1);
    const owners = (
      await admin.query(
        "SELECT id FROM store_users WHERE store_id=$1 AND active AND role='OWNER'",
        [storeIds[0]],
      )
    ).rows;
    expect(owners).toHaveLength(1);
  });
});
