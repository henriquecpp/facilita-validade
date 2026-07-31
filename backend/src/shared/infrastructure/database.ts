import { Pool } from 'pg';
/**
 * Parâmetros de sessão de toda conexão que o Prisma usa. O adaptador do Prisma lê
 * timestamptz descartando o deslocamento da sessão — fora de UTC, todo instante lido
 * sairia deslocado — e só entende datas no formato ISO. Fixar os dois na conexão
 * tira essa dependência da configuração do servidor.
 */
export const SESSION_OPTIONS = '-c TimeZone=UTC -c DateStyle=ISO';
/**
 * As conexões do processo, uma por papel do banco. O acesso aos dados passa pelo
 * `PrismaDatabase`, que usa estes pools; aqui só se abre e se fecha.
 *
 * - `pool` usa o papel `app_runtime`, sob RLS.
 * - `auth` usa o papel `app_auth`, que só executa as funções de pré-autenticação.
 */
export class Database {
  readonly pool: Pool;
  readonly auth: Pool;
  constructor(url = process.env.DATABASE_URL, authUrl = process.env.AUTH_DATABASE_URL) {
    const session = { connectionTimeoutMillis: 5000, options: SESSION_OPTIONS };
    this.pool = new Pool({ connectionString: url, max: 10, ...session });
    this.auth = new Pool({ connectionString: authUrl, max: 3, ...session });
  }
  async close() {
    await Promise.all([this.pool.end(), this.auth.end()]);
  }
}
