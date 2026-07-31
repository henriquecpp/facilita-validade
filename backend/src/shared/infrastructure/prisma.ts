import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../../generated/prisma/client.js';
import type { Database } from './database.js';

export type PrismaTx = Prisma.TransactionClient;

const TENANT = /^[\da-f-]{36}$/i;

/** Espera por uma conexão livre do pool. */
const MAX_WAIT_MS = 5_000;
/**
 * Limite da transação inteira, e só como rede de segurança. Quem limita o trabalho é o
 * `statement_timeout` (15 s por consulta) e o `lock_timeout` (5 s por espera de trava),
 * como no acesso por SQL anterior, que não tinha limite total. Uma reconstrução de
 * estoque cresce com o histórico do produto — 20 mil vendas desde a última contagem
 * levaram 9 s em desenvolvimento —, e o Prisma recusa o commit de uma transação que
 * passou do limite: com um limite curto, ela falharia depois de fazer todo o trabalho,
 * e de novo a cada tentativa do job. Fica abaixo da expiração dos jobs do pg-boss (15 min).
 */
const TRANSACTION_TIMEOUT_MS = 300_000;

export interface TenantOptions {
  /**
   * Leitura de várias consultas no mesmo snapshot (REPEATABLE READ, somente leitura).
   * Comandos continuam em READ COMMITTED, travando antes de ler.
   */
  readOnlySnapshot?: boolean;
}

/**
 * Acesso ao banco. Todo repositório passa por aqui.
 *
 * Os dois clientes usam os pools do {@link Database}, um por papel do banco.
 *
 * - `runtime` usa o papel `app_runtime`, sob RLS. Só é seguro dentro de
 *   {@link PrismaDatabase.tenant}, que fixa a loja da transação.
 * - `auth` usa o papel `app_auth` e existe apenas para chamar as funções
 *   SECURITY DEFINER de pré-autenticação (`auth.resolve_*`). Esse papel não lê
 *   tabela nenhuma diretamente.
 */
export class PrismaDatabase {
  readonly runtime: PrismaClient;
  readonly auth: PrismaClient;

  constructor(database: Database) {
    this.runtime = new PrismaClient({ adapter: new PrismaPg(database.pool) });
    this.auth = new PrismaClient({ adapter: new PrismaPg(database.auth) });
  }

  /**
   * Transação no contexto de uma loja.
   *
   * `set_config(..., true)` vale só para esta transação, na mesma conexão em que
   * todas as consultas de `tx` rodam; o RLS compara `store_id` com esse valor.
   * Sem ele, nenhuma linha operacional é visível. Os timeouts limitam quanto uma
   * consulta lenta ou uma espera por trava prende a conexão.
   */
  async tenant<T>(
    storeId: string,
    fn: (tx: PrismaTx) => Promise<T>,
    options: TenantOptions = {},
  ): Promise<T> {
    if (!TENANT.test(storeId)) throw new Error('Invalid tenant context');
    return this.runtime.$transaction(
      async (tx) => {
        // Uma escrita acidental num caminho de leitura falha em vez de passar.
        if (options.readOnlySnapshot) await tx.$executeRaw`SET TRANSACTION READ ONLY`;
        await tx.$queryRaw`SELECT set_config('app.store_id', ${storeId}, true),
          set_config('statement_timeout', '15000', true),
          set_config('lock_timeout', '5000', true)`;
        return fn(tx);
      },
      {
        maxWait: MAX_WAIT_MS,
        timeout: TRANSACTION_TIMEOUT_MS,
        ...(options.readOnlySnapshot
          ? { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
          : {}),
      },
    );
  }

  /** Os pools pertencem ao `Database`; aqui só se liberam os clientes. */
  async close(): Promise<void> {
    await Promise.all([this.runtime.$disconnect(), this.auth.$disconnect()]);
  }
}
