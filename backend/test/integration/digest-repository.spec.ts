import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../../src/shared/infrastructure/database.js';
import { PrismaDatabase } from '../../src/shared/infrastructure/prisma.js';
import { PrismaDigests } from '../../src/modules/notifications/adapters/out/prisma-digests.js';
import { testCnpj } from '../support/cnpj.js';

/**
 * A reserva do resumo diário decide, no banco, quem envia e quando se tenta de novo.
 * O serviço é testado com dublês; aqui fica a parte que só o PostgreSQL garante.
 */
describe('Repositório do resumo diário', () => {
  const storeId = randomUUID();
  let admin: Pool, database: Database, prisma: PrismaDatabase, digests: PrismaDigests;
  const day = (offset: number) =>
    new Date(Date.UTC(2026, 0, 1 + offset)).toISOString().slice(0, 10);
  const delivery = async (id: string) =>
    (
      await admin.query<{ status: string; attempts: number; alert_count: number; retry: boolean }>(
        'SELECT status, attempts, alert_count, next_attempt_at IS NOT NULL AS retry FROM notification_deliveries WHERE id=$1',
        [id],
      )
    ).rows[0];

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await admin.query(
      "INSERT INTO stores(id,cnpj_normalized,name,timezone) VALUES($1,$2,'Loja Resumo','America/Manaus')",
      [storeId, testCnpj()],
    );
    await admin.query(
      "INSERT INTO store_settings(store_id,alert_emails,digest_hour) VALUES($1,ARRAY['a@loja.test'],9)",
      [storeId],
    );
    database = new Database();
    prisma = new PrismaDatabase(database);
    digests = new PrismaDigests(prisma);
  });

  afterAll(async () => {
    if (admin) {
      await admin.query('DELETE FROM notification_deliveries WHERE store_id=$1', [storeId]);
      await admin.query('DELETE FROM expiry_levels WHERE store_id=$1', [storeId]);
      await admin.query('DELETE FROM store_settings WHERE store_id=$1', [storeId]);
      await admin.query('DELETE FROM stores WHERE id=$1', [storeId]);
      await admin.end();
    }
    await prisma?.close();
    await database?.close();
  });

  it('lê a agenda no fuso da loja', async () => {
    const schedule = await digests.schedule(storeId);
    const local = (
      await admin.query<{ date: string; hour: number }>(
        "SELECT to_char(clock_timestamp() AT TIME ZONE 'America/Manaus','YYYY-MM-DD') AS date, extract(hour FROM clock_timestamp() AT TIME ZONE 'America/Manaus')::int AS hour",
      )
    ).rows[0]!;
    expect(schedule).toEqual({
      storeName: 'Loja Resumo',
      localDate: local.date,
      localHour: local.hour,
      digestHour: 9,
      recipients: { email: ['a@loja.test'] },
      // Sem Pagonet, não há como saber se as vendas pararam.
      salesDelayedThrough: null,
    });
    expect(await digests.schedule(randomUUID())).toBeNull();
  });

  it('reserva uma vez por dia e só retoma falha vencida ou envio interrompido', async () => {
    const first = await digests.claim(storeId, 'email', day(0), ['a@loja.test']);
    expect(first).toEqual({ id: expect.any(String), attempts: 1 });
    // Em andamento e recente: ninguém mais reserva.
    expect(await digests.claim(storeId, 'email', day(0), ['a@loja.test'])).toBeNull();

    // Falha com nova tentativa já vencida: volta a ser reservável.
    await digests.finish(storeId, first!, {
      status: 'FAILED',
      alertCount: 3,
      error: 'SMTP fora',
      retryInMinutes: 0,
    });
    expect(await delivery(first!.id)).toEqual({
      status: 'FAILED',
      attempts: 1,
      alert_count: 3,
      retry: true,
    });
    const second = await digests.claim(storeId, 'email', day(0), ['b@loja.test']);
    expect(second).toEqual({ id: first!.id, attempts: 2 });

    // Falha definitiva: sem próxima tentativa, não é mais reservado.
    await digests.finish(storeId, second!, {
      status: 'FAILED',
      alertCount: 3,
      error: 'destinatário recusado',
      retryInMinutes: null,
    });
    expect(await delivery(first!.id)).toMatchObject({ status: 'FAILED', retry: false });
    expect(await digests.claim(storeId, 'email', day(0), ['a@loja.test'])).toBeNull();

    // Envio interrompido há mais de 10 minutos é retomado.
    const other = await digests.claim(storeId, 'email', day(1), ['a@loja.test']);
    expect(await digests.claim(storeId, 'email', day(1), ['a@loja.test'])).toBeNull();
    await admin.query(
      "UPDATE notification_deliveries SET updated_at=clock_timestamp()-interval '11 minutes' WHERE id=$1",
      [other!.id],
    );
    expect(await digests.claim(storeId, 'email', day(1), ['a@loja.test'])).toEqual({
      id: other!.id,
      attempts: 2,
    });

    // Enviado ou dispensado encerra o dia.
    await digests.finish(storeId, other!, {
      status: 'SENT',
      alertCount: 2,
      providerMessageId: 'm1',
    });
    expect(await delivery(other!.id)).toEqual({
      status: 'SENT',
      attempts: 2,
      alert_count: 2,
      retry: false,
    });
    expect(await digests.claim(storeId, 'email', day(1), ['a@loja.test'])).toBeNull();
    const skipped = await digests.claim(storeId, 'email', day(2), []);
    await digests.finish(storeId, skipped!, { status: 'SKIPPED' });
    expect(await delivery(skipped!.id)).toMatchObject({ status: 'SKIPPED', alert_count: 0 });
    expect(await digests.claim(storeId, 'email', day(2), [])).toBeNull();
  });

  it('não lista alertas sem notificação ativa e traz os níveis que avisam, em ordem', async () => {
    const { alerts, sections } = await digests.activeAlerts(storeId);
    expect(alerts).toEqual([]);
    // Os níveis padrão de toda loja nova; o Em dia não avisa.
    expect(sections.map(({ title, expired }) => [title, expired])).toEqual([
      ['Vencido', true],
      ['Urgente', false],
      ['Atenção', false],
    ]);
  });
});
