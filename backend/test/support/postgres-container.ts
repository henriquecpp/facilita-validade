import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { applyMigrations } from '../../src/bootstrap/migrations.js';

// Mesma imagem fixada do Compose e da produção.
const IMAGE = 'postgres:18.6-alpine';

/**
 * Sobe um PostgreSQL descartável, aplica migrations e papéis como em produção e
 * expõe as URLs aos testes. Nenhum teste de banco usa a base de desenvolvimento.
 */
export default async function setup() {
  const container = await new PostgreSqlContainer(IMAGE)
    .withDatabase('estoque')
    .withUsername('postgres')
    .withPassword('test_admin_only')
    .start();
  const address = `${container.getHost()}:${container.getPort()}/estoque`;
  const admin = `postgresql://postgres:test_admin_only@${address}`;
  await applyMigrations(admin, { localRolePasswords: true });

  Object.assign(process.env, {
    NODE_ENV: 'test',
    MIGRATION_DATABASE_URL: admin,
    DATABASE_URL: `postgresql://app_runtime:local_runtime_only@${address}`,
    AUTH_DATABASE_URL: `postgresql://app_auth:local_auth_only@${address}`,
    JWT_SECRET: 'integration-test-secret-with-at-least-32-bytes',
    WEB_ORIGIN: 'http://localhost:5174',
    RUN_IDENTITY_DB_TESTS: '1',
  });

  return async () => {
    await container.stop();
  };
}
