import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Compose mounts files; only this process receives the resolved secrets.
for (const name of [
  'DATABASE_URL',
  'AUTH_DATABASE_URL',
  'MIGRATION_DATABASE_URL',
  'JWT_SECRET',
  'SMTP_PASSWORD',
  'PAGONET_TOKEN',
  'WEB_PUSH_PRIVATE_KEY',
  'IDENTITY_TEMPORARY_PASSWORD',
  'PLATFORM_ADMIN_TEMPORARY_PASSWORD',
]) {
  const file = process.env[`${name}_FILE`];
  if (file) {
    if (process.env[name]) throw new Error(`Configure ${name} ou ${name}_FILE, sem duplicar.`);
    process.env[name] = (await readFile(file, 'utf8')).trimEnd();
    if (!process.env[name]) throw new Error(`${name}_FILE está vazio.`);
  }
}
const target = process.argv[2];
if (!target) throw new Error('Informe o ponto de entrada do backend.');
if (target.endsWith('main-api.js') || target.endsWith('main-worker.js')) {
  if (process.env.MIGRATION_DATABASE_URL)
    throw new Error('Runtime não pode receber a credencial de migração.');
  for (const [name, role] of [
    ['DATABASE_URL', 'app_runtime'],
    ['AUTH_DATABASE_URL', 'app_auth'],
  ]) {
    if (!process.env[name] || decodeURIComponent(new URL(process.env[name]).username) !== role) {
      throw new Error(`${name} deve usar exclusivamente o papel ${role}.`);
    }
  }
}
if (target.endsWith('main-api.js') && process.env.NODE_ENV === 'production') {
  const origin = process.env.WEB_ORIGIN;
  if (!origin || new URL(origin).protocol !== 'https:' || new URL(origin).origin !== origin) {
    throw new Error('WEB_ORIGIN deve ser uma origem HTTPS sem barra final.');
  }
}
process.argv.splice(1, 1);
await import(pathToFileURL(resolve(target)).href);
