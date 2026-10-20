import { readFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, it } from 'vitest';

let pool: Pool;
const migration = await readFile(
  new URL('../../migrations/0018_expiry_hierarchy.sql', import.meta.url),
  'utf8',
);

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.MIGRATION_DATABASE_URL });
});
afterAll(async () => pool?.end());

it('migra faixas antigas sem perder níveis, cores, preferências ou suas referências', async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Tabelas temporárias reproduzem a estrutura anterior, isoladas de todas as lojas
    // usadas pelos testes. O SQL executado é o mesmo arquivo aplicado em produção.
    await client.query(`
      CREATE TEMP TABLE store_settings (
        store_id text PRIMARY KEY, levels_version integer NOT NULL
      ) ON COMMIT DROP;
      CREATE TEMP TABLE expiry_levels (
        id text PRIMARY KEY, store_id text NOT NULL, name text NOT NULL,
        min_days integer CONSTRAINT expiry_levels_min_days_check
          CHECK (min_days BETWEEN -36500 AND 36500),
        max_days integer CHECK (max_days BETWEEN -36500 AND 36500),
        color text NOT NULL, notify boolean NOT NULL,
        CHECK (min_days IS NULL OR max_days IS NULL OR min_days <= max_days)
      ) ON COMMIT DROP;
      INSERT INTO store_settings VALUES ('changed', 3), ('same', 7), ('empty', 5), ('edge', 1);
      INSERT INTO expiry_levels VALUES
        ('expired', 'changed', 'Já venceu', NULL, -1, '#112233', false),
        ('urgent', 'changed', 'Prioridade', 2, 5, '#223344', true),
        ('attention', 'changed', 'Atenção', 10, 15, '#334455', false),
        ('ok', 'changed', 'Normal', 30, NULL, '#445566', true),
        ('same-a', 'same', 'Primeiro', NULL, 5, '#556677', true),
        ('same-b', 'same', 'Último', 6, NULL, '#667788', false),
        ('edge-a', 'edge', 'Limite máximo', NULL, 36500, '#778899', false),
        ('edge-b', 'edge', 'Aberto', 36500, NULL, '#889900', false);
    `);
    const before = await client.query(
      'SELECT id, store_id, name, max_days, color, notify FROM expiry_levels ORDER BY id',
    );
    await client.query(migration);
    const after = await client.query(
      'SELECT id, store_id, name, max_days, color, notify FROM expiry_levels ORDER BY id',
    );
    expect(after.rows).toEqual(before.rows);
    const ranges = await client.query(
      "SELECT min_days, max_days FROM expiry_levels WHERE store_id='changed' ORDER BY max_days NULLS LAST",
    );
    expect(ranges.rows).toEqual([
      { min_days: null, max_days: -1 },
      { min_days: 0, max_days: 5 },
      { min_days: 6, max_days: 15 },
      { min_days: 16, max_days: null },
    ]);
    expect((await client.query('SELECT * FROM store_settings ORDER BY store_id')).rows).toEqual([
      { store_id: 'changed', levels_version: 4 },
      { store_id: 'edge', levels_version: 2 },
      { store_id: 'empty', levels_version: 5 },
      { store_id: 'same', levels_version: 7 },
    ]);
    expect(
      (await client.query("SELECT min_days FROM expiry_levels WHERE id='edge-b'")).rows,
    ).toEqual([{ min_days: 36501 }]);
    // A edição pode trocar limites no mesmo commit; a unicidade é adiada para o fim.
    await client.query("UPDATE expiry_levels SET min_days=6, max_days=15 WHERE id='urgent'");
    await client.query("UPDATE expiry_levels SET min_days=0, max_days=5 WHERE id='attention'");
    await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});
