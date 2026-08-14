import { applyMigrations } from './migrations.js';

const url = process.env.MIGRATION_DATABASE_URL;
if (!url) throw new Error('MIGRATION_DATABASE_URL é obrigatória.');
await applyMigrations(url, {
  // Credenciais exclusivamente para o Compose local e testes; nunca em produção.
  localRolePasswords: process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test',
  log: console.log,
});
console.log('Migrations e filas aplicadas.');
