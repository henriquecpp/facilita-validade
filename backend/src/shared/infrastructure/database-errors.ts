/**
 * SQLSTATE de um erro do PostgreSQL, venha ele direto do driver `pg` ou embrulhado
 * pelo Prisma.
 *
 * O Prisma troca o erro do driver pelo dele (`P2002`, `P2010`...), mas preserva o
 * código original em `meta.driverAdapterError.cause.originalCode` — tanto nas
 * consultas tipadas quanto no SQL explícito. Quem decide pela causa (conflito,
 * lock, timeout) deve perguntar aqui, e não olhar `error.code`.
 */
export function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const cause = (
    error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } }
  ).meta?.driverAdapterError?.cause;
  if (typeof cause?.originalCode === 'string') return cause.originalCode;
  // Erro do `pg`: a gravidade distingue um erro do servidor de um erro de sistema
  // como ECONNREFUSED, que também tem `code`.
  const { code, severity } = error as { code?: unknown; severity?: unknown };
  return typeof code === 'string' && typeof severity === 'string' ? code : undefined;
}

/** Violação de unicidade ou de chave estrangeira: o dado conflita com o que já existe. */
export function isDataConflict(error: unknown): boolean {
  const state = sqlState(error);
  return state === '23505' || state === '23503';
}
