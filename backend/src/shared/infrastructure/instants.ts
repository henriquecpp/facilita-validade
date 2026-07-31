import { Prisma } from '../../generated/prisma/client.js';

/**
 * Datas e instantes entre o Prisma e a aplicação.
 *
 * A aplicação troca instantes como texto ISO 8601 UTC e datas civis como
 * `YYYY-MM-DD`. O Prisma entrega `Date`, que só guarda milissegundos, e representa
 * uma data civil (`@db.Date`) como meia-noite UTC. Estas funções fazem a conversão
 * num lugar só.
 */

export const iso = (value: Date): string => value.toISOString();

export const isoOrNull = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

/** Data civil lida de uma coluna `@db.Date`. */
export const civilDate = (value: Date): string => value.toISOString().slice(0, 10);

export const civilDateOrNull = (value: Date | null | undefined): string | null =>
  value ? civilDate(value) : null;

/**
 * Instante em SQL, como texto ISO 8601 UTC com microssegundos.
 *
 * O estoque compara instantes em microssegundos (`timestampMicros`), a precisão do
 * relógio do banco. O que a regra exige é que todos sejam comparados na mesma
 * precisão: um corte de contagem truncado para milissegundos, comparado a uma venda
 * com microssegundos, pode trocar a venda de lado. Um `Date` truncaria, então todo
 * instante que alimenta o domínio sai do banco por aqui.
 * Recebe só nomes de coluna escritos no código, nunca entrada externa.
 */
export const instantSql = (column: string): Prisma.Sql =>
  Prisma.raw(`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`);

/** Data civil em SQL, como texto `YYYY-MM-DD`. Mesma restrição de {@link instantSql}. */
export const civilDateSql = (column: string): Prisma.Sql =>
  Prisma.raw(`to_char(${column}, 'YYYY-MM-DD')`);
