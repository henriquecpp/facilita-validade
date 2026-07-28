import { defineConfig } from 'prisma/config';

// O Prisma 7 não carrega .env por conta própria. O resto do projeto usa o
// --env-file do Node; aqui o equivalente nativo, sem depender de dotenv.
try {
  process.loadEnvFile('../.env');
} catch {
  // Sem .env (CI, container): as variáveis já vêm do ambiente.
}

/**
 * Configuração da CLI do Prisma. As migrations continuam em `migrations/*.sql`,
 * aplicadas pelo runner próprio: elas carregam RLS, papéis do banco e funções
 * SECURITY DEFINER, que o Prisma Migrate não expressa. O Prisma aqui é o cliente
 * tipado, e o schema vem de introspecção (`db:pull`) com o papel de migração,
 * que enxerga todas as tabelas.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: process.env.MIGRATION_DATABASE_URL ?? '',
  },
});
