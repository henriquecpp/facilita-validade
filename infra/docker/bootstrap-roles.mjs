import { Pool } from 'pg';

const admin = new URL(process.env.MIGRATION_DATABASE_URL ?? '');
const credentials = [
  ['app_runtime', 'DATABASE_URL'],
  ['app_auth', 'AUTH_DATABASE_URL'],
].map(([role, name]) => {
  const connection = new URL(process.env[name] ?? '');
  if (
    connection.hostname !== admin.hostname ||
    connection.port !== admin.port ||
    connection.pathname !== admin.pathname ||
    decodeURIComponent(connection.username) !== role ||
    !connection.password
  ) {
    throw new Error(
      `${name} precisa apontar para o mesmo banco administrativo, com papel ${role} e senha.`,
    );
  }
  return [role, decodeURIComponent(connection.password)];
});
const pool = new Pool({ connectionString: admin.toString(), max: 1 });
const client = await pool.connect();
try {
  await client.query('BEGIN');
  for (const [role, password] of credentials) {
    const result = await client.query(
      "SELECT format('ALTER ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', $1::text, $2::text) AS command",
      [role, password],
    );
    await client.query(result.rows[0].command);
  }
  await client.query('COMMIT');
  console.log('Papéis de runtime configurados.');
} catch {
  await client.query('ROLLBACK');
  throw new Error(
    'Não foi possível configurar os papéis. Confira migrations e permissões administrativas.',
  );
} finally {
  client.release();
  await pool.end();
}
