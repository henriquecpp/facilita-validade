import { PgBoss } from 'pg-boss';
import type { PrismaTx } from './prisma.js';

export interface SendOptions {
  startAfter?: Date;
  /**
   * Com `singletonSeconds`, no máximo um job com esta chave por janela de tempo: um envio
   * repetido dentro da janela é descartado pelo pg-boss, sem erro.
   */
  singletonKey?: string;
  singletonSeconds?: number;
}

export class Jobs {
  readonly boss: PgBoss;
  constructor(url = process.env.DATABASE_URL) {
    this.boss = new PgBoss({
      connectionString: url,
      migrate: false,
      supervise: true,
      schedule: false,
      persistQueueStats: false,
      persistWarnings: false,
      reindex: false,
      createSchema: false,
    });
    this.boss.on('error', (error) => console.error('queue_error', error.message));
  }
  async start() {
    await this.boss.start();
  }
  async stop() {
    await this.boss.stop();
  }

  /**
   * Enfileira dentro de uma transação de `PrismaDatabase.tenant`.
   *
   * O pg-boss grava o job pelo executor recebido, e não pelo pool próprio: o INSERT
   * roda na conexão da transação de negócio, então commit e rollback valem para a
   * operação e para o job juntos. Sem isso, um job poderia existir para uma operação
   * desfeita, ou uma operação confirmada ficar sem o job que a processa. O SQL vem do
   * pg-boss e os valores vão como parâmetros.
   */
  async send(
    tx: PrismaTx,
    storeId: string,
    name: string,
    data: Record<string, unknown>,
    options: SendOptions = {},
  ) {
    return this.boss.send(
      name,
      { ...data, storeId },
      {
        retryLimit: 5,
        retryBackoff: true,
        ...options,
        db: {
          executeSql: async (text, values) => ({
            rows: await tx.$queryRawUnsafe<unknown[]>(text, ...(values ?? [])),
          }),
        },
      },
    );
  }
}
