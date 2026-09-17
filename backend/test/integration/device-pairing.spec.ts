import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/bootstrap/app.js';
import { ArgonJwtCrypto } from '../../src/modules/identity/adapters/out/identity-crypto.js';
import { Database } from '../../src/shared/infrastructure/database.js';
import { PrismaDatabase } from '../../src/shared/infrastructure/prisma.js';
import { testCnpj } from '../support/cnpj.js';

const SECRET = 'pairing-test-secret-with-at-least-32-bytes';

describe('Pareamento de coletor por QR, com Prisma e RLS reais', () => {
  const stores = { a: randomUUID(), b: randomUUID() };
  const cnpj = { a: testCnpj(), b: testCnpj() };
  const users = {
    owner: randomUUID(),
    manager: randomUUID(),
    operator: randomUUID(),
    newbie: randomUUID(), // operador ainda com senha provisória
    operatorB: randomUUID(),
  };
  const password = 'SenhaDePareamento!2026';
  let database: Database;
  let prisma: PrismaDatabase;
  let admin: Pool;
  let ctx: Awaited<ReturnType<typeof createApp>>;
  const tokens: Record<'owner' | 'manager' | 'operator', string> = {
    owner: '',
    manager: '',
    operator: '',
  };

  function request(method: InjectOptions['method'], url: string, body?: unknown, bearer?: string) {
    return ctx.app.inject({
      method,
      url: `/api/v1${url}`,
      headers: {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      payload: body ? JSON.stringify(body) : undefined,
    });
  }

  async function issue(userId = users.operator, bearer = tokens.owner) {
    const response = await request('POST', '/device-pairings', { userId }, bearer);
    return { response, body: response.json() as { code: string; expiresAt: string } };
  }

  beforeAll(async () => {
    database = new Database();
    prisma = new PrismaDatabase(database);
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    const hash = await new ArgonJwtCrypto(SECRET).hashPassword(password);
    for (const [key, id] of Object.entries(stores))
      await admin.query('INSERT INTO stores(id,cnpj_normalized,name) VALUES($1,$2,$3)', [
        id,
        cnpj[key as 'a' | 'b'],
        `Pareamento ${key}`,
      ]);
    const insertUser = (id: string, store: string, name: string, role: string, pending: boolean) =>
      admin.query(
        'INSERT INTO store_users(id,store_id,username,username_normalized,password_hash,role,must_change_password) VALUES($1,$2,$3,$3,$4,$5,$6)',
        [id, store, name, hash, role, pending],
      );
    await insertUser(users.owner, stores.a, 'dono', 'OWNER', false);
    await insertUser(users.manager, stores.a, 'gestor', 'MANAGER', false);
    await insertUser(users.operator, stores.a, 'repositor', 'OPERATOR', false);
    await insertUser(users.newbie, stores.a, 'novato', 'OPERATOR', true);
    await insertUser(users.operatorB, stores.b, 'repositor', 'OPERATOR', false);

    ctx = await createApp({ database, prisma, jwtSecret: SECRET });
    await ctx.app.getHttpAdapter().getInstance().ready();
    for (const [role, username] of [
      ['owner', 'dono'],
      ['manager', 'gestor'],
      ['operator', 'repositor'],
    ] as const) {
      const login = await request('POST', '/auth/mobile/login', {
        cnpj: cnpj.a,
        username,
        password,
      });
      tokens[role] = login.json().accessToken;
    }
  });

  afterAll(async () => {
    await ctx?.app.close();
    await ctx?.jobs.stop();
    if (admin) {
      const all = Object.values(stores);
      for (const table of [
        'device_pairings',
        'audit_events',
        'refresh_tokens',
        'push_subscriptions',
        'auth_sessions',
        'store_users',
        'expiry_levels',
        'store_settings',
      ])
        await admin.query(`DELETE FROM ${table} WHERE store_id=ANY($1::uuid[])`, [all]);
      await admin.query('DELETE FROM stores WHERE id=ANY($1::uuid[])', [all]);
      await admin.end();
    }
    await prisma?.close();
    await database?.close();
  });

  it('o proprietário gera o código e o coletor troca por uma sessão do operador', async () => {
    const { response, body } = await issue();
    expect(response.statusCode).toBe(201);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(body.code).toMatch(/^estoque-pair:1:[A-Za-z0-9_-]{43}$/);
    const ttl = Date.parse(body.expiresAt) - Date.now();
    expect(ttl).toBeGreaterThan(100_000);
    expect(ttl).toBeLessThanOrEqual(120_000);

    const redeemed = await request('POST', '/auth/mobile/pair', { code: body.code });
    expect(redeemed.statusCode).toBe(200);
    const session = redeemed.json();
    expect(session.refreshToken).toBeTruthy();
    expect(session.mustChangePassword).toBe(false);
    expect(session.store.id).toBe(stores.a);

    const me = await request('GET', '/me', undefined, session.accessToken);
    expect(me.statusCode).toBe(200);
    expect(me.json().user.username).toBe('repositor');
    expect(me.json().user.role).toBe('OPERATOR');
  });

  it('o código vale uma vez só', async () => {
    const { body } = await issue();
    expect((await request('POST', '/auth/mobile/pair', { code: body.code })).statusCode).toBe(200);
    const again = await request('POST', '/auth/mobile/pair', { code: body.code });
    expect(again.statusCode).toBe(401);
    expect(again.json().code).toBe('INVALID_PAIRING');
  });

  it('duas leituras simultâneas do mesmo QR geram uma única sessão', async () => {
    const { body } = await issue();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => request('POST', '/auth/mobile/pair', { code: body.code })),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 401, 401, 401, 401]);
  });

  it('código expirado é recusado com a mesma mensagem genérica', async () => {
    const { body } = await issue();
    // O CHECK exige expires_at > created_at, então os dois recuam juntos.
    await admin.query(
      "UPDATE device_pairings SET created_at=now()-interval '10 minutes', expires_at=now()-interval '5 minutes' WHERE store_id=$1 AND consumed_at IS NULL",
      [stores.a],
    );
    const expired = await request('POST', '/auth/mobile/pair', { code: body.code });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().code).toBe('INVALID_PAIRING');
  });

  it('código adulterado, de outra versão ou lixo não revela nada', async () => {
    const { body } = await issue();
    const secret = body.code.split(':')[2]!;
    // A troca precisa sempre mudar o segredo. O último caractere de 32 bytes em base64url
    // só assume 16 valores: trocá-lo por 'A' deixava o código intacto 1 vez em 16.
    const tampered = `${secret[0] === 'A' ? 'B' : 'A'}${secret.slice(1)}`;
    for (const code of [
      `estoque-pair:1:${tampered}`,
      `estoque-pair:2:${secret}`,
      `outro-app:1:${secret}`,
      '7890000000017',
      '',
    ]) {
      const response = await request('POST', '/auth/mobile/pair', { code });
      expect(response.statusCode, code).toBe(401);
      expect(response.json().code, code).toBe('INVALID_PAIRING');
    }
  });

  it('só o proprietário gera código', async () => {
    expect((await issue(users.operator, tokens.manager)).response.statusCode).toBe(403);
    expect((await issue(users.operator, tokens.operator)).response.statusCode).toBe(403);
    expect((await issue(users.operator, '')).response.statusCode).toBe(401);
  });

  it('só operadores podem ser pareados', async () => {
    for (const target of [users.owner, users.manager]) {
      const { response } = await issue(target);
      expect(response.statusCode).toBe(422);
      expect(response.json().code).toBe('PAIRING_NOT_OPERATOR');
    }
  });

  it('operador com senha provisória precisa trocá-la antes', async () => {
    const { response } = await issue(users.newbie);
    expect(response.statusCode).toBe(422);
    expect(response.json().code).toBe('PAIRING_PASSWORD_PENDING');
  });

  it('usuário de outra loja não existe para o proprietário', async () => {
    const { response } = await issue(users.operatorB);
    expect(response.statusCode).toBe(404);
  });

  it('operador desativado entre a geração e a leitura não entra', async () => {
    const { body } = await issue();
    await admin.query('UPDATE store_users SET active=false WHERE id=$1', [users.operator]);
    try {
      const response = await request('POST', '/auth/mobile/pair', { code: body.code });
      expect(response.statusCode).toBe(401);
    } finally {
      await admin.query('UPDATE store_users SET active=true WHERE id=$1', [users.operator]);
    }
  });

  it('a trilha de auditoria registra emissão e uso', async () => {
    const { body } = await issue();
    await request('POST', '/auth/mobile/pair', { code: body.code });
    const { rows } = await admin.query<{ action: string; actor_id: string }>(
      "SELECT action, actor_id FROM audit_events WHERE store_id=$1 AND action IN ('DEVICE_PAIRING_ISSUED','AUTH_DEVICE_PAIRED') ORDER BY created_at DESC LIMIT 2",
      [stores.a],
    );
    expect(rows).toEqual([
      { action: 'AUTH_DEVICE_PAIRED', actor_id: users.operator },
      { action: 'DEVICE_PAIRING_ISSUED', actor_id: users.owner },
    ]);
  });

  it('o banco guarda só o hash, nunca o código', async () => {
    const { body } = await issue();
    const secret = body.code.split(':')[2]!;
    const { rows } = await admin.query<{ token_hash: string }>(
      'SELECT token_hash FROM device_pairings WHERE store_id=$1',
      [stores.a],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.token_hash !== secret && /^[0-9a-f]{64}$/.test(r.token_hash))).toBe(
      true,
    );
  });

  describe('coletores conectados', () => {
    type DeviceSession = { id: string; username: string; startedAt: string; lastActiveAt: string };
    const sessions = async (bearer = tokens.owner) =>
      (await request('GET', '/device-sessions', undefined, bearer)).json().items as DeviceSession[];
    /** Entra no coletor e devolve a sessão nova, achada pela diferença na lista. */
    async function collector(username: string) {
      const before = new Set((await sessions()).map((item) => item.id));
      const login = await request('POST', '/auth/mobile/login', {
        cnpj: cnpj.a,
        username,
        password,
      });
      expect(login.statusCode, login.body).toBe(200);
      const created = (await sessions()).filter((item) => !before.has(item.id));
      expect(created).toHaveLength(1);
      return { ...(login.json() as { accessToken: string; refreshToken: string }), ...created[0]! };
    }

    it('o proprietário vê o coletor e o desconecta; o coletor ouve o motivo ao renovar', async () => {
      const device = await collector('repositor');
      expect(device.username).toBe('repositor');
      expect(Date.parse(device.lastActiveAt)).toBeGreaterThanOrEqual(Date.parse(device.startedAt));

      const revoked = await request(
        'POST',
        `/device-sessions/${device.id}/revoke`,
        {},
        tokens.owner,
      );
      expect(revoked.statusCode, revoked.body).toBe(200);
      expect(revoked.json()).toEqual({ id: device.id });
      // O acesso em mãos para na próxima chamada, sem esperar o token vencer.
      expect((await request('GET', '/me', undefined, device.accessToken)).statusCode).toBe(401);
      const refresh = await request('POST', '/auth/mobile/refresh', {
        refreshToken: device.refreshToken,
      });
      expect(refresh.statusCode).toBe(401);
      expect(refresh.json()).toMatchObject({
        code: 'SESSION_REVOKED',
        message: expect.stringContaining('administrador da loja desconectou'),
      });
      expect((await sessions()).some((item) => item.id === device.id)).toBe(false);

      // De novo: nada muda, e o histórico registra uma vez só.
      expect(
        (await request('POST', `/device-sessions/${device.id}/revoke`, {}, tokens.owner))
          .statusCode,
      ).toBe(200);
      const { rows } = await admin.query(
        "SELECT actor_id FROM audit_events WHERE action='AUTH_DEVICE_SESSION_REVOKED' AND entity_id=$1",
        [device.id],
      );
      expect(rows).toEqual([{ actor_id: users.owner }]);
    });

    it('só o proprietário lista e desconecta coletores', async () => {
      const device = await collector('repositor');
      for (const bearer of [tokens.manager, tokens.operator]) {
        expect((await request('GET', '/device-sessions', undefined, bearer)).statusCode).toBe(403);
        expect(
          (await request('POST', `/device-sessions/${device.id}/revoke`, {}, bearer)).statusCode,
        ).toBe(403);
      }
      expect((await request('GET', '/me', undefined, device.accessToken)).statusCode).toBe(200);
    });

    it('não alcança sessão de outra loja nem sessão do painel', async () => {
      const other = await request('POST', '/auth/mobile/login', {
        cnpj: cnpj.b,
        username: 'repositor',
        password,
      });
      expect(other.statusCode).toBe(200);
      const {
        rows: [fromB],
      } = await admin.query<{ id: string }>(
        "SELECT id FROM auth_sessions WHERE store_id=$1 AND client='mobile' ORDER BY created_at DESC LIMIT 1",
        [stores.b],
      );
      const web = randomUUID();
      await admin.query(
        "INSERT INTO auth_sessions(id,store_id,user_id,client,expires_at) VALUES($1,$2,$3,'web',now()+interval '1 day')",
        [web, stores.a, users.manager],
      );
      for (const id of [fromB!.id, web]) {
        const response = await request('POST', `/device-sessions/${id}/revoke`, {}, tokens.owner);
        expect(response.statusCode).toBe(404);
        expect(response.json().code).toBe('DEVICE_SESSION_NOT_FOUND');
      }
      // A lista é só de coletores: a sessão do painel não aparece.
      expect((await sessions()).map((item) => item.id)).not.toContain(web);
      expect((await request('GET', '/me', undefined, other.json().accessToken)).statusCode).toBe(
        200,
      );
    });

    it('alterar o usuário pelo painel também conta como desconexão pelo administrador', async () => {
      const id = randomUUID();
      const hash = await new ArgonJwtCrypto(SECRET).hashPassword(password);
      await admin.query(
        "INSERT INTO store_users(id,store_id,username,username_normalized,password_hash,role,must_change_password) VALUES($1,$2,'conferente','conferente',$3,'OPERATOR',false)",
        [id, stores.a, hash],
      );
      const device = await collector('conferente');
      const updated = await request(
        'PATCH',
        `/users/${id}`,
        { expectedVersion: 1, username: 'conferente' },
        tokens.owner,
      );
      expect(updated.statusCode, updated.body).toBe(200);
      const refresh = await request('POST', '/auth/mobile/refresh', {
        refreshToken: device.refreshToken,
      });
      expect(refresh.json().code).toBe('SESSION_REVOKED');
      // Sair pelo próprio coletor não é desconexão pelo administrador.
      const again = await collector('conferente');
      await request('POST', '/auth/mobile/logout', { refreshToken: again.refreshToken });
      const afterLogout = await request('POST', '/auth/mobile/refresh', {
        refreshToken: again.refreshToken,
      });
      expect(afterLogout.json().code).toBe('INVALID_SESSION');
    });
  });

  describe('camada Prisma', () => {
    it('a transação da loja só enxerga as linhas dela', async () => {
      const deA = await prisma.tenant(stores.a, (tx) => tx.device_pairings.count());
      const deB = await prisma.tenant(stores.b, (tx) => tx.device_pairings.count());
      expect(deA).toBeGreaterThan(0);
      expect(deB).toBe(0);
    });

    it('fora de uma transação de loja, o RLS não mostra nada', async () => {
      expect(await prisma.runtime.device_pairings.count()).toBe(0);
    });

    it('datas voltam como Date apesar dos parsers globais do pg', async () => {
      // O Database registra parsers globais que devolvem DATE/TIMESTAMPTZ como texto.
      // O Prisma compartilha o pool; se os parsers vazassem, isto seria string.
      const row = await prisma.tenant(stores.a, (tx) =>
        tx.device_pairings.findFirst({ select: { expires_at: true, created_at: true } }),
      );
      expect(row?.expires_at).toBeInstanceOf(Date);
      expect(row?.created_at).toBeInstanceOf(Date);
    });

    it('recusa contexto de loja malformado antes de abrir transação', async () => {
      await expect(prisma.tenant("' OR 1=1 --", async () => 1)).rejects.toThrow(
        'Invalid tenant context',
      );
    });
  });
});
