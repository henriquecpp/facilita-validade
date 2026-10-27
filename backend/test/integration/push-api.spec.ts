import {
  createDecipheriv,
  createECDH,
  generateKeyPairSync,
  hkdfSync,
  randomUUID,
} from 'node:crypto';
import { Pool } from 'pg';
import { hash, argon2id } from 'argon2';
import type { InjectOptions } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/bootstrap/app.js';
import { Jobs } from '../../src/shared/infrastructure/jobs.js';
import { PrismaPush } from '../../src/modules/notifications/adapters/out/prisma-push.js';
import {
  vapidFromEnv,
  WebPushSender,
} from '../../src/modules/notifications/adapters/out/web-push.js';
import { stableId } from '../../src/modules/integration/adapters/out/prisma-integration.js';
import { testCnpj } from '../support/cnpj.js';
import type { PushPreferences } from '../../src/modules/notifications/domain/schedules.js';

/** Decifra o conteúdo como o navegador (RFC 8291), com a chave da inscrição. */
function decrypt(body: Buffer, receiverPrivate: Buffer, auth: Buffer) {
  const salt = body.subarray(0, 16);
  const sender = body.subarray(21, 21 + body[20]!);
  const ciphertext = body.subarray(21 + body[20]!);
  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(receiverPrivate);
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), ecdh.getPublicKey(), sender]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdh.computeSecret(sender), auth, info, 32));
  const key = (label: string, length: number) =>
    Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(`Content-Encoding: ${label}\0`), length));
  const decipher = createDecipheriv('aes-128-gcm', key('aes128gcm', 16), key('nonce', 12));
  decipher.setAuthTag(ciphertext.subarray(-16));
  const plain = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  return JSON.parse(plain.subarray(0, -1).toString('utf8')) as {
    title: string;
    body: string;
    url: string;
  };
}

/**
 * Push do proprietário com PostgreSQL real (AV18, AV25): inscrição presa à sessão, só o
 * proprietário, e os alertas do minuto num push só.
 */
describe('Notificações push', () => {
  const storeId = randomUUID(),
    ownerId = randomUUID(),
    operatorId = randomUUID(),
    cnpj = testCnpj();
  const password = 'TestePush!2026';
  let admin: Pool, jobs: Jobs, ctx: Awaited<ReturnType<typeof createApp>>;
  let owner: string, operator: string, ownerSession: string;
  const delivered: { url: string; body: Buffer }[] = [];
  const receiver = createECDH('prime256v1');
  receiver.generateKeys();
  const auth = Buffer.from('0123456789abcdef');
  const subscription = {
    kind: 'WEB',
    endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`,
    p256dh: receiver.getPublicKey().toString('base64url'),
    auth: auth.toString('base64url'),
  };

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

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await admin.query("INSERT INTO stores(id,cnpj_normalized,name) VALUES($1,$2,'Loja Push')", [
      storeId,
      cnpj,
    ]);
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
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = privateKey.export({ format: 'jwk' });
    const point = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(jwk.x!, 'base64url'),
      Buffer.from(jwk.y!, 'base64url'),
    ]);
    const vapid = vapidFromEnv({
      WEB_PUSH_PUBLIC_KEY: point.toString('base64url'),
      WEB_PUSH_PRIVATE_KEY: jwk.d!,
      WEB_PUSH_SUBJECT: 'mailto:suporte@example.com',
    })!;
    jobs = new Jobs();
    await jobs.start();
    ctx = await createApp({
      jobs,
      jwtSecret: 'test-push-api-secret-at-least-thirty-two-bytes',
      notificationChannels: [],
      push: (prisma) =>
        new PrismaPush(
          prisma,
          new WebPushSender(vapid, async (url, init) => {
            delivered.push({ url: String(url), body: Buffer.from(init!.body as Uint8Array) });
            return new Response(null, { status: 201 });
          }),
        ),
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
    ownerSession = (
      await admin.query<{ id: string }>(
        'SELECT id FROM auth_sessions WHERE store_id=$1 AND user_id=$2 ORDER BY created_at DESC LIMIT 1',
        [storeId, ownerId],
      )
    ).rows[0]!.id;
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
        'stock_movements',
        'stock_records',
        'inventory_epochs',
        'count_lines',
        'count_sessions',
        'product_inventory',
        'product_barcodes',
        'products',
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

  it('só o proprietário se inscreve, e só num serviço de push de navegador', async () => {
    expect((await call('/push/config')).json()).toMatchObject({
      allowed: true,
      webPushPublicKey: expect.any(String),
      fcmProjectId: null,
    });
    expect((await call('/push/config', 'GET', undefined, operator)).json()).toMatchObject({
      allowed: false,
    });
    expect((await call('/push/subscriptions', 'POST', subscription, operator)).statusCode).toBe(
      403,
    );
    const forged = await call('/push/subscriptions', 'POST', {
      ...subscription,
      endpoint: 'https://169.254.169.254/latest',
    });
    expect(forged.statusCode).toBe(422);
    const saved = await call('/push/subscriptions', 'POST', subscription);
    expect(saved.statusCode, saved.body).toBe(201);
    // Inscrever de novo o mesmo navegador não duplica.
    expect((await call('/push/subscriptions', 'POST', subscription)).statusCode).toBe(201);
    const rows = await admin.query('SELECT session_id FROM push_subscriptions WHERE store_id=$1', [
      storeId,
    ]);
    expect(rows.rows).toEqual([{ session_id: ownerSession }]);
  });

  it('junta num push só os lotes que entraram num nível que avisa', async () => {
    const connection = await ctx.integration.createConnection(
      { storeId, userId: ownerId, role: 'OWNER', sessionId: ownerSession, restricted: false },
      randomUUID(),
      'ERP push',
    );
    const actor = {
      storeId,
      userId: ownerId,
      role: 'OWNER' as const,
      sessionId: ownerSession,
      restricted: false,
    };
    const day = (days: number) =>
      new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
    for (const name of ['iogurte', 'coalhada']) {
      await ctx.prisma.tenant(storeId, (tx) =>
        ctx.integration.upsertProduct(tx, storeId, connection.id, {
          externalProductId: name,
          description: name === 'iogurte' ? 'Iogurte natural' : 'Coalhada',
          barcodes: [],
        }),
      );
      const productId = stableId(storeId, connection.id, name, 'product');
      let session = await ctx.inventory.createCount(actor, randomUUID(), productId);
      session = await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
        type: 'lines',
        expectedVersion: session.version,
        lines: [
          { id: randomUUID(), expiresOn: day(2), quantity: 4 },
          ...(name === 'iogurte' ? [{ id: randomUUID(), expiresOn: day(3), quantity: 6 }] : []),
        ],
      });
      await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
        type: 'confirm',
        expectedVersion: session.version,
        completeConfirmed: true,
      });
    }
    await ctx.notifications.evaluate(storeId);
    delivered.length = 0;
    const result = await ctx.push.flush(storeId);
    expect(result).toMatchObject({ targets: 1, sent: 1 });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.url).toBe(subscription.endpoint);
    const level = (
      await admin.query<{ id: string }>(
        "SELECT id FROM expiry_levels WHERE store_id=$1 AND name='Urgente'",
        [storeId],
      )
    ).rows[0]!;
    expect(decrypt(delivered[0]!.body, receiver.getPrivateKey(), auth)).toEqual({
      title: 'Urgente: 3 lotes',
      body: 'Toque para consultar os lotes deste nível.',
      url: `/expiries?nivel=${level.id}`,
      tag: `nivel-${level.id}`,
    });
    // Nada pendente: a próxima varredura não repete o aviso.
    expect(await ctx.push.flush(storeId)).toBeNull();
  });

  it('aguarda a projeção final sem perder a pendência de push', async () => {
    await admin.query('UPDATE notifications SET push_pending=true WHERE store_id=$1 AND active', [
      storeId,
    ]);
    await admin.query(
      'UPDATE product_inventory SET input_revision=input_revision+1 WHERE store_id=$1',
      [storeId],
    );
    delivered.length = 0;
    expect(await ctx.push.flush(storeId)).toBeNull();
    expect(delivered).toHaveLength(0);
    expect(
      (
        await admin.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM notifications WHERE store_id=$1 AND push_pending',
          [storeId],
        )
      ).rows[0]!.count,
    ).toBe(3);
    await admin.query(
      'UPDATE product_inventory SET applied_input_revision=input_revision WHERE store_id=$1',
      [storeId],
    );
    await ctx.notifications.evaluate(storeId);
    expect(await ctx.push.flush(storeId)).toMatchObject({ sent: 1 });
    expect(await ctx.push.flush(storeId)).toBeNull();
  });

  it('somente proprietário configura combinações, com versão e horários válidos', async () => {
    expect((await call('/push/preferences', 'GET', undefined, operator)).statusCode).toBe(403);
    const previous = (await call('/push/preferences')).json<PushPreferences>();
    expect(previous).toMatchObject({ version: 0, dailyDigestEnabled: true, depletedEnabled: true });
    const input = {
      expectedVersion: previous.version,
      dailyDigestEnabled: false,
      depletedEnabled: false,
      levels: previous.levels.map((level) => ({
        ...level,
        immediate: false,
        intervalHours: 3,
        dailyTime: '00:00',
      })),
    };
    expect((await call('/push/preferences', 'PUT', input, operator)).statusCode).toBe(403);
    expect(
      (
        await call('/push/preferences', 'PUT', {
          ...input,
          levels: [{ ...input.levels[0], dailyTime: '24:00' }],
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call('/push/preferences', 'PUT', {
          ...input,
          levels: input.levels.map((level) => ({ ...level, intervalHours: 0 })),
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call('/push/preferences', 'PUT', {
          ...input,
          levels: input.levels.map((level) => ({ ...level, levelId: randomUUID() })),
        })
      ).statusCode,
    ).toBe(409);
    const saved = await call('/push/preferences', 'PUT', input);
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toMatchObject({
      version: 1,
      dailyDigestEnabled: false,
      depletedEnabled: false,
    });
    expect((await call('/push/preferences', 'PUT', input)).statusCode).toBe(409);
    expect(await ctx.push.recipients(storeId, true)).toEqual([]);
    expect(await ctx.push.recipients(storeId)).toHaveLength(1);
  });

  it('funde horários coincidentes e reserva uma vez com workers concorrentes, no fuso da loja', async () => {
    await admin.query("UPDATE stores SET timezone='Pacific/Honolulu' WHERE id=$1", [storeId]);
    // Mudança de alerta é descartada pelo imediato desabilitado; as agendas permanecem ativas.
    await admin.query('UPDATE notifications SET push_pending=true WHERE store_id=$1 AND active', [
      storeId,
    ]);
    delivered.length = 0;
    await Promise.all([ctx.push.flush(storeId), ctx.push.flush(storeId)]);
    expect(delivered).toHaveLength(1);
    expect(decrypt(delivered[0]!.body, receiver.getPrivateKey(), auth).title).toBe(
      'Urgente: 3 lotes',
    );
    const date = (
      await admin.query<{ date: string }>(
        "SELECT to_char(clock_timestamp() AT TIME ZONE 'Pacific/Honolulu','YYYY-MM-DD') AS date",
      )
    ).rows[0]!.date;
    const keys = (
      await admin.query<{ schedule_key: string }>(
        'SELECT schedule_key FROM push_schedule_claims WHERE store_id=$1 ORDER BY schedule_key',
        [storeId],
      )
    ).rows.map((row) => row.schedule_key);
    expect(keys).toHaveLength(2);
    expect(keys).toContain(`daily:${date}`);
    expect(keys.some((key) => key.startsWith(`hours:3:${date}:`))).toBe(true);
    expect(await ctx.push.flush(storeId)).toBeNull();
  });

  it('avisa a última parcela do lote, sem repetir no replay, e respeita desligar a baixa', async () => {
    const actor = {
      storeId,
      userId: ownerId,
      role: 'OWNER' as const,
      sessionId: ownerSession,
      restricted: false,
    };
    const connectionId = (
      await admin.query<{ id: string }>(
        'SELECT id FROM integration_connections WHERE store_id=$1 LIMIT 1',
        [storeId],
      )
    ).rows[0]!.id;
    const productId = stableId(storeId, connectionId, 'baixa-final', 'product');
    await ctx.prisma.tenant(storeId, (tx) =>
      ctx.integration.upsertProduct(tx, storeId, connectionId, {
        externalProductId: 'baixa-final',
        description: 'Leite teste baixa',
        barcodes: [],
      }),
    );
    const day = (offset: number) =>
      new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
    let count = await ctx.inventory.createCount(actor, randomUUID(), productId);
    count = await ctx.inventory.updateCount(actor, randomUUID(), count.id, {
      type: 'lines',
      expectedVersion: count.version,
      lines: ['A', 'B', 'C'].map((lotCode, index) => ({
        id: randomUUID(),
        expiresOn: day(index + 1),
        quantity: 10,
        lotCode,
      })),
    });
    await ctx.inventory.updateCount(actor, randomUUID(), count.id, {
      type: 'confirm',
      expectedVersion: count.version,
      completeConfirmed: true,
    });
    const enable = async (depletedEnabled: boolean) => {
      const preferences = (await call('/push/preferences')).json<PushPreferences>();
      const saved = await call('/push/preferences', 'PUT', {
        expectedVersion: preferences.version,
        levels: preferences.levels,
        dailyDigestEnabled: preferences.dailyDigestEnabled,
        depletedEnabled,
      });
      expect(saved.statusCode, saved.body).toBe(200);
    };
    await enable(true);
    const occurredAt = (
      await admin.query<{ instant: string }>(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS instant`,
      )
    ).rows[0]!.instant;
    const insertSale = async (externalEventId: string, quantity: number, at: string) => {
      const id = randomUUID();
      const payload = {
        id,
        storeId,
        productId,
        type: 'SALE',
        quantity,
        occurredAt: at,
        source: { kind: 'ERP', connectionId, externalEventId },
      };
      await admin.query(
        'INSERT INTO stock_movements(id,store_id,product_id,occurred_at,payload) VALUES($1,$2,$3,$4,$5::jsonb)',
        [id, storeId, productId, at, JSON.stringify(payload)],
      );
    };
    // Chegam invertidas; o motor aplica origem A antes de B no mesmo microssegundo.
    await insertSale('B-venda-5', 5, occurredAt);
    await insertSale('A-venda-8', 8, occurredAt);
    const rebuild = async () => {
      await admin.query(
        'UPDATE product_inventory SET input_revision=input_revision+1 WHERE store_id=$1 AND product_id=$2',
        [storeId, productId],
      );
      await ctx.prisma.tenant(storeId, (tx) => ctx.inventory.rebuild(tx, storeId, productId));
      await ctx.notifications.evaluate(storeId, productId);
    };
    await rebuild();
    const quantity = (
      await admin.query<{ depleted_quantity: number }>(
        "SELECT n.depleted_quantity FROM notifications n JOIN stock_records r ON r.store_id=n.store_id AND r.id=n.record_id WHERE n.store_id=$1 AND n.product_id=$2 AND n.type='DEPLETED' AND r.lot_code='A'",
        [storeId, productId],
      )
    ).rows[0]!.depleted_quantity;
    expect(quantity).toBe(2);
    delivered.length = 0;
    expect(await ctx.push.flush(storeId)).toMatchObject({ sent: 1 });
    expect(delivered).toHaveLength(1);
    const message = decrypt(delivered[0]!.body, receiver.getPrivateKey(), auth);
    expect(message.title).toBe('Lote baixado: Leite teste baixa');
    expect(message.body).toContain('Última baixa: 2 un. do lote A');
    expect(message.url).toBe(`/products/${productId}`);
    await rebuild();
    expect(await ctx.push.flush(storeId)).toBeNull();
    await enable(false);
    const next = (
      await admin.query<{ instant: string }>(
        `SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS instant`,
      )
    ).rows[0]!.instant;
    await insertSale('C-venda-7', 7, next);
    await rebuild();
    expect(await ctx.push.flush(storeId)).toBeNull();
    expect(delivered).toHaveLength(1);
  });

  it('sessão encerrada para de receber, mesmo sem o aparelho avisar', async () => {
    await admin.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [
      ownerSession,
    ]);
    const result = await ctx.push.deliver(storeId, {
      title: 'Teste',
      body: 'Depois de sair',
      url: '/alerts',
      tag: 'teste',
    });
    expect(result).toMatchObject({ targets: 0, sent: 0 });
  });
});
