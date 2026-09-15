import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Database } from '../../src/shared/infrastructure/database.js';
import { Jobs } from '../../src/shared/infrastructure/jobs.js';
import { PrismaDatabase } from '../../src/shared/infrastructure/prisma.js';
import { testCnpj } from '../support/cnpj.js';

/**
 * O requisito que decide entre manter ou trocar o pg-boss: o job precisa ser gravado
 * na mesma transação da operação de negócio. Estes testes provam isso na transação
 * do Prisma, com o papel de runtime e o schema do pg-boss reais.
 */
describe('pg-boss na transação do Prisma', () => {
  const store = randomUUID();
  let database: Database;
  let prisma: PrismaDatabase;
  let jobs: Jobs;
  let admin: Pool;

  const jobsWith = async (marker: string) =>
    Number(
      (
        await admin.query<{ n: string }>(
          "SELECT count(*) AS n FROM pgboss.job WHERE data->>'marker' = $1",
          [marker],
        )
      ).rows[0]!.n,
    );
  const auditWith = async (marker: string) =>
    Number(
      (
        await admin.query<{ n: string }>(
          "SELECT count(*) AS n FROM audit_events WHERE detail->>'marker' = $1",
          [marker],
        )
      ).rows[0]!.n,
    );

  async function businessWrite(
    tx: Parameters<Parameters<PrismaDatabase['tenant']>[1]>[0],
    marker: string,
  ) {
    await tx.audit_events.create({
      data: {
        id: randomUUID(),
        store_id: store,
        action: 'TEST',
        entity_id: store,
        detail: { marker },
      },
      select: { id: true },
    });
  }

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
    await admin.query("INSERT INTO stores(id,cnpj_normalized,name) VALUES($1,$2,'Jobs')", [
      store,
      testCnpj(),
    ]);
    database = new Database();
    prisma = new PrismaDatabase(database);
    jobs = new Jobs();
    await jobs.start();
  });

  afterAll(async () => {
    await jobs?.stop();
    if (admin) {
      await admin.query("DELETE FROM pgboss.job WHERE data->>'storeId' = $1", [store]);
      await admin.query('DELETE FROM audit_events WHERE store_id = $1', [store]);
      await admin.query('DELETE FROM stores WHERE id = $1', [store]);
      await admin.end();
    }
    await prisma?.close();
    await database?.close();
  });

  it('commit grava a operação e o job juntos', async () => {
    const marker = randomUUID();
    const id = await prisma.tenant(store, async (tx) => {
      await businessWrite(tx, marker);
      return jobs.send(tx, store, 'maintenance.cleanup', { marker });
    });
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await auditWith(marker)).toBe(1);
    expect(await jobsWith(marker)).toBe(1);
  });

  it('rollback desfaz a operação e o job juntos', async () => {
    const marker = randomUUID();
    await expect(
      prisma.tenant(store, async (tx) => {
        await businessWrite(tx, marker);
        await jobs.send(tx, store, 'maintenance.cleanup', { marker });
        throw new Error('falha depois de enfileirar');
      }),
    ).rejects.toThrow('falha depois de enfileirar');
    // Nem a escrita de negócio nem o job sobreviveram.
    expect(await auditWith(marker)).toBe(0);
    expect(await jobsWith(marker)).toBe(0);
  });

  it('o job carrega a loja, como no envio pelo SQL explícito', async () => {
    const marker = randomUUID();
    await prisma.tenant(store, (tx) => jobs.send(tx, store, 'maintenance.cleanup', { marker }));
    const { rows } = await admin.query<{ store: string }>(
      "SELECT data->>'storeId' AS store FROM pgboss.job WHERE data->>'marker' = $1",
      [marker],
    );
    expect(rows).toEqual([{ store }]);
  });
});
