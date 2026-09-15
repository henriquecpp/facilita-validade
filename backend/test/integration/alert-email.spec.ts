import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { hash, argon2id } from 'argon2';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/bootstrap/app.js';
import { Database } from '../../src/shared/infrastructure/database.js';
import { Jobs } from '../../src/shared/infrastructure/jobs.js';
import type { TenantActor } from '../../src/shared/domain/context.js';
import { stableId } from '../../src/modules/integration/adapters/out/prisma-integration.js';
import { SmtpEmailChannel } from '../../src/modules/notifications/adapters/out/smtp-email-channel.js';

interface MailpitMessage {
  ID: string;
  Subject: string;
  To: { Address: string }[];
}

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

describe('Resumo diário por e-mail com SMTP real (Mailpit)', () => {
  const storeId = randomUUID(),
    userId = randomUUID(),
    taxId = cnpj(),
    password = 'TesteAlertaEmail!2026';
  const actor: TenantActor = {
    storeId,
    userId,
    role: 'OWNER',
    sessionId: randomUUID(),
    restricted: false,
  };
  let mailpit: StartedTestContainer,
    mailApi: string,
    channel: SmtpEmailChannel,
    db: Database,
    admin: Pool,
    jobs: Jobs,
    ctx: Awaited<ReturnType<typeof createApp>>,
    token: string;

  async function messages(): Promise<MailpitMessage[]> {
    const response = await fetch(`${mailApi}/api/v1/messages`);
    return ((await response.json()) as { messages: MailpitMessage[] }).messages;
  }
  const inDays = (days: number) =>
    new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    mailpit = await new GenericContainer('axllent/mailpit:v1.31.3')
      .withExposedPorts(1025, 8025)
      .withWaitStrategy(Wait.forHttp('/readyz', 8025))
      .start();
    mailApi = `http://${mailpit.getHost()}:${mailpit.getMappedPort(8025)}`;
    channel = new SmtpEmailChannel({
      host: mailpit.getHost(),
      port: mailpit.getMappedPort(1025),
      secure: false,
      from: 'Alertas <alertas@estoque.test>',
    });
    db = new Database();
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    jobs = new Jobs();
    await jobs.start();
    await admin.query('INSERT INTO stores(id,cnpj_normalized,name) VALUES($1,$2,$3)', [
      storeId,
      taxId,
      'Loja Alertas',
    ]);
    // digest_hour 0: o resumo do dia já está liberado em qualquer horário do teste.
    await admin.query(
      "INSERT INTO store_settings(store_id,digest_hour,alert_emails) VALUES($1,0,'{gerente@loja.test}')",
      [storeId],
    );
    await admin.query(
      "INSERT INTO store_users(id,store_id,username,username_normalized,password_hash,role,must_change_password) VALUES($1,$2,'dono','dono',$3,'OWNER',false)",
      [
        userId,
        storeId,
        await hash(password, { type: argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 }),
      ],
    );
    ctx = await createApp({
      database: db,
      jobs,
      jwtSecret: 'test-alert-email-secret-at-least-thirty-two-bytes',
      notificationChannels: [channel],
    });
    const login = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/auth/mobile/login',
      payload: { cnpj: taxId, username: 'dono', password },
    });
    expect(login.statusCode, login.body).toBe(200);
    token = login.json().accessToken;

    const connection = await ctx.integration.createConnection(actor, randomUUID(), 'ERP alertas');
    const productId = stableId(storeId, connection.id, 'iogurte-1', 'product');
    await ctx.prisma.tenant(storeId, (tx) =>
      ctx.integration.upsertProduct(tx, storeId, connection.id, {
        externalProductId: 'iogurte-1',
        description: 'Iogurte <natural> 170g',
        barcodes: ['7890000000017'],
      }),
    );
    let session = await ctx.inventory.createCount(actor, randomUUID(), productId);
    session = await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
      type: 'lines',
      expectedVersion: session.version,
      lines: [
        { id: randomUUID(), expiresOn: inDays(2), lotCode: 'L-1', quantity: 6 },
        { id: randomUUID(), expiresOn: inDays(90), quantity: 20 },
      ],
    });
    await ctx.inventory.updateCount(actor, randomUUID(), session.id, {
      type: 'confirm',
      expectedVersion: session.version,
      completeConfirmed: true,
    });
    await ctx.notifications.evaluate(storeId);
  });

  afterAll(async () => {
    channel?.close();
    await ctx?.app.close();
    await jobs?.stop();
    await admin?.end();
    await db?.close();
    await mailpit?.stop();
  });

  it('envia o resumo uma única vez por dia e registra o envio', async () => {
    expect(await ctx.digests.runDue(storeId)).toEqual([{ channel: 'email', status: 'SENT' }]);
    const sent = await messages();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.To.map((to) => to.Address)).toEqual(['gerente@loja.test']);
    expect(sent[0]!.Subject).toMatch(/^\[Facilita Validade\] Loja Alertas: Urgente: 1 \(/);
    const body = await (await fetch(`${mailApi}/api/v1/message/${sent[0]!.ID}`)).json();
    expect(body.Text).toContain('URGENTE (1)');
    expect(body.Text).toContain('Iogurte <natural> 170g');
    expect(body.HTML).toContain('Iogurte &lt;natural&gt; 170g');
    expect(body.Text).not.toContain('20 un.');

    expect(await ctx.digests.runDue(storeId)).toEqual([]);
    expect(await messages()).toHaveLength(1);

    const settings = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/store/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(settings.json()).toMatchObject({
      alertEmails: ['gerente@loja.test'],
      digestHour: 0,
      emailAvailable: true,
      lastDigestStatus: 'SENT',
      lastDigestError: null,
    });
  });

  it('salva destinatários normalizados e envia e-mail de teste só para o proprietário', async () => {
    const current = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/store/settings',
      headers: { authorization: `Bearer ${token}` },
    });
    const updated = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/store/settings',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      payload: {
        expectedVersion: current.json().version,
        timezone: 'America/Sao_Paulo',
        alertEmails: [' Dono@Loja.test ', 'dono@loja.test', 'gerente@loja.test'],
        digestHour: 7,
      },
    });
    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json()).toMatchObject({
      alertEmails: ['dono@loja.test', 'gerente@loja.test'],
      digestHour: 7,
    });
    const invalid = await ctx.app.inject({
      method: 'PATCH',
      url: '/api/v1/store/settings',
      headers: { authorization: `Bearer ${token}`, 'idempotency-key': randomUUID() },
      payload: {
        expectedVersion: updated.json().version,
        timezone: 'America/Sao_Paulo',
        alertEmails: ['não-é-email'],
      },
    });
    expect(invalid.statusCode).toBe(400);

    const before = (await messages()).length;
    const test = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/store/settings/test-email',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(test.statusCode, test.body).toBe(201);
    expect(test.json()).toEqual({ recipients: 2 });
    const latest = (await messages())[0]!;
    expect((await messages()).length).toBe(before + 1);
    expect(latest.Subject).toBe('[Facilita Validade] Loja Alertas: teste de envio');
  });
});
