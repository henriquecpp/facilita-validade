import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { argon2id, hash } from 'argon2';
import { ApplicationError } from '../shared/domain/context.js';
import { normalizeUsername, validatePassword } from '../modules/identity/domain/identity.js';
import { SESSION_OPTIONS } from '../shared/infrastructure/database.js';
import { sqlState } from '../shared/infrastructure/database-errors.js';

/**
 * Administradores do painel da plataforma, com a credencial de migração (fora da API):
 *
 *   create      cria com senha provisória, trocada no primeiro acesso
 *   reset       nova senha provisória; encerra as sessões abertas e reativa quem estava
 *               desativado (a senha nova é de quem executa, não do antigo dono)
 *   deactivate  tira o acesso; encerra as sessões abertas
 *
 * Variáveis: MIGRATION_DATABASE_URL, PLATFORM_ADMIN_USERNAME, PLATFORM_OPERATOR (quem executa,
 * vai para o histórico) e, para create e reset, PLATFORM_ADMIN_TEMPORARY_PASSWORD.
 */
const ACTIONS = {
  create: 'PLATFORM_ADMIN_CREATED',
  reset: 'PLATFORM_ADMIN_RESET',
  deactivate: 'PLATFORM_ADMIN_DEACTIVATED',
} as const;
type Command = keyof typeof ACTIONS;

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Defina ${name} para executar este comando administrativo.`);
  return value;
}

async function main() {
  const command = process.argv[2] as Command | undefined;
  if (!command || !(command in ACTIONS))
    throw new Error(
      'Uso: platform-admin.js create | reset | deactivate. Consulte docs/plataforma.md.',
    );
  const display = required('PLATFORM_ADMIN_USERNAME').trim();
  const username = normalizeUsername(display);
  const operator = required('PLATFORM_OPERATOR').trim().slice(0, 160);
  let passwordHash: string | undefined;
  if (command !== 'deactivate') {
    const password = required('PLATFORM_ADMIN_TEMPORARY_PASSWORD');
    validatePassword(password);
    passwordHash = await hash(password, {
      type: argon2id,
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });
  }
  const pool = new Pool({
    connectionString: required('MIGRATION_DATABASE_URL'),
    connectionTimeoutMillis: 5000,
    max: 1,
    options: SESSION_OPTIONS,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    let id: string | undefined;
    if (command === 'create') {
      id = randomUUID();
      await client.query(
        'INSERT INTO platform.admins(id, username, username_normalized, password_hash) VALUES ($1, $2, $3, $4)',
        [id, display, username, passwordHash],
      );
    } else {
      id = (
        await client.query<{ id: string }>(
          'SELECT id FROM platform.admins WHERE username_normalized = $1 FOR UPDATE',
          [username],
        )
      ).rows[0]?.id;
      if (!id)
        throw new ApplicationError(
          'ADMIN_NOT_FOUND',
          'Administrador da plataforma não encontrado.',
        );
      if (command === 'reset')
        await client.query(
          'UPDATE platform.admins SET password_hash = $2, must_change_password = true, active = true WHERE id = $1',
          [id, passwordHash],
        );
      else await client.query('UPDATE platform.admins SET active = false WHERE id = $1', [id]);
      await client.query(
        'UPDATE platform.sessions SET revoked_at = clock_timestamp() WHERE admin_id = $1 AND revoked_at IS NULL',
        [id],
      );
    }
    // Quem executou fica no detalhe; o administrador afetado, em `username`.
    await client.query('INSERT INTO platform.events(id, action, detail) VALUES ($1, $2, $3)', [
      randomUUID(),
      ACTIONS[command],
      { operator, username },
    ]);
    await client.query('COMMIT');
    const result =
      command === 'deactivate'
        ? { id, username, active: false }
        : { id, username, active: true, mustChangePassword: true };
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

try {
  await main();
} catch (error) {
  if (error instanceof ApplicationError) console.error(`${error.code}: ${error.message}`);
  else if (sqlState(error) === '23505')
    console.error('ALREADY_EXISTS: esse administrador já existe; nada foi alterado.');
  else
    console.error(
      error instanceof Error && !('code' in error)
        ? error.message
        : 'Falha administrativa; verifique conectividade, permissões e logs do banco.',
    );
  process.exitCode = 1;
}
