import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { PgBoss } from 'pg-boss';

export const QUEUES = [
  'import.process',
  'inventory.rebuild',
  'notifications.evaluate',
  'maintenance.cleanup',
  'pagonet.catalog',
  'pagonet.sales',
  'pagonet.history',
] as const;

const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));
const LOCK_ID = 19092842;

export interface MigrationOptions {
  /** Define senhas fixas de desenvolvimento para app_runtime/app_auth. Nunca em produção. */
  localRolePasswords?: boolean;
  log?: (message: string) => void;
}

/** Aplica o SQL versionado, cria as filas do pg-boss e concede acesso ao runtime. */
export async function applyMigrations(url: string, options: MigrationOptions = {}): Promise<void> {
  const pool = new Pool({ connectionString: url, max: 1 });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_ID]);
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, hash text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const names = (await readdir(MIGRATIONS_DIR)).filter((n) => n.endsWith('.sql')).sort();
    for (const name of names) {
      const text = await readFile(`${MIGRATIONS_DIR}${name}`, 'utf8');
      const hash = createHash('sha256').update(text).digest('hex');
      const applied = await client.query<{ hash: string }>(
        'SELECT hash FROM schema_migrations WHERE name=$1',
        [name],
      );
      if (applied.rows[0]) {
        if (applied.rows[0].hash !== hash) throw new Error(`Migration alterada: ${name}`);
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(text);
        await client.query('INSERT INTO schema_migrations(name,hash) VALUES($1,$2)', [name, hash]);
        await client.query('COMMIT');
        options.log?.(`Migration aplicada: ${name}`);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    if (options.localRolePasswords) {
      await client.query(
        "ALTER ROLE app_runtime LOGIN PASSWORD 'local_runtime_only'; ALTER ROLE app_auth LOGIN PASSWORD 'local_auth_only'",
      );
    }
    const boss = new PgBoss({ connectionString: url, supervise: false, schedule: false });
    await boss.start();
    const existing = new Set((await boss.getQueues()).map((queue) => queue.name));
    for (const name of QUEUES) {
      if (!existing.has(name)) await boss.createQueue(name, { retryLimit: 5, retryBackoff: true });
    }
    await boss.stop();
    await client.query(
      'GRANT USAGE ON SCHEMA pgboss TO app_runtime; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA pgboss TO app_runtime; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA pgboss TO app_runtime',
    );
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    client.release();
    await pool.end();
  }
}
