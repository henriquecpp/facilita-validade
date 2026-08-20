import { PrismaPg } from '@prisma/adapter-pg';
import { Pool } from 'pg';
import { PrismaClient } from '../generated/prisma/client.js';
import { ApplicationError } from '../shared/domain/context.js';
import { PrismaIdentityAdmin } from '../modules/identity/adapters/out/prisma-identity-admin.js';
import { SESSION_OPTIONS } from '../shared/infrastructure/database.js';
import { sqlState } from '../shared/infrastructure/database-errors.js';

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Defina ${name} para executar este comando administrativo.`);
  return value;
}
async function main() {
  const command = process.argv[2];
  if (!['provision-store', 'recover-owner'].includes(command ?? ''))
    throw new Error(
      'Uso: identity-admin.js provision-store | recover-owner. Consulte docs/identity-validacao.md.',
    );
  const cnpj = required('IDENTITY_STORE_CNPJ'),
    username = required('IDENTITY_OWNER_USERNAME'),
    operator = required('IDENTITY_OPERATOR');
  const pool = new Pool({
    connectionString: required('MIGRATION_DATABASE_URL'),
    connectionTimeoutMillis: 5000,
    max: 1,
    options: SESSION_OPTIONS,
  });
  const client = new PrismaClient({ adapter: new PrismaPg(pool) });
  const admin = new PrismaIdentityAdmin(client);
  try {
    const result =
      command === 'provision-store'
        ? await admin.provision({
            cnpj,
            username,
            operator,
            storeName: required('IDENTITY_STORE_NAME'),
            temporaryPassword: required('IDENTITY_TEMPORARY_PASSWORD'),
          })
        : await admin.recoverOwner({
            cnpj,
            username,
            operator,
            reason: required('IDENTITY_RECOVERY_REASON'),
          });
    // Recovery deliberately emits the one-use credential once; do not collect stdout in shared logs.
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    await client.$disconnect();
    await pool.end();
  }
}
try {
  await main();
} catch (error) {
  if (error instanceof ApplicationError) console.error(`${error.code}: ${error.message}`);
  else if (sqlState(error) === '23505')
    console.error(
      'ALREADY_EXISTS: CNPJ ou usuário já cadastrado; nenhuma credencial foi alterada.',
    );
  else
    console.error(
      error instanceof Error && !('code' in error)
        ? error.message
        : 'Falha administrativa; verifique conectividade, permissões e logs do banco.',
    );
  process.exitCode = 1;
}
