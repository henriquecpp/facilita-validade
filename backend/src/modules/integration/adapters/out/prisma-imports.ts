import type { ListOptions } from '../../../../shared/domain/pagination.js';
import { page } from '../../../../shared/infrastructure/pagination.js';
import type { PrismaDatabase } from '../../../../shared/infrastructure/prisma.js';
import type { Jobs } from '../../../../shared/infrastructure/jobs.js';
import { command, audit } from '../../../../shared/infrastructure/commands.js';
import { instantSql } from '../../../../shared/infrastructure/instants.js';
import {
  ApplicationError,
  requireRole,
  type TenantActor,
} from '../../../../shared/domain/context.js';
export class PrismaImports {
  constructor(
    readonly prisma: PrismaDatabase,
    readonly jobs: Jobs,
  ) {}
  list(actor: TenantActor, id?: string, options: ListOptions = {}) {
    requireRole(actor, ['OWNER', 'MANAGER']);
    const limit = options.limit ?? 50;
    const only = id ?? null;
    const cursor = options.cursor ?? null;
    return this.prisma.tenant(actor.storeId, async (tx) => {
      // Itens do lote: produtos num catálogo, eventos num lote de movimentos. Processado é o
      // que já tem situação final — aceito ou com pendência —, não só o que deu certo.
      const rows = await tx.$queryRaw<
        {
          id: string;
          externalBatchId: string;
          status: string;
          createdAt: string;
          errors: { externalId: string; code: string }[];
          eventCount: number;
          processedCount: number;
        }[]
      >`SELECT b.id, b.external_batch_id AS "externalBatchId", b.status,
               ${instantSql('b.created_at')} AS "createdAt", b.errors,
               CASE WHEN b.kind = 'CATALOG'
                    THEN jsonb_array_length(coalesce(b.payload->'products', '[]'::jsonb))
                    ELSE (SELECT count(*)::int FROM integration_events e
                           WHERE e.store_id = b.store_id AND e.batch_id = b.id) END AS "eventCount",
               CASE WHEN b.kind = 'CATALOG'
                    THEN CASE WHEN b.status LIKE 'COMPLETED%'
                              THEN jsonb_array_length(coalesce(b.payload->'products', '[]'::jsonb))
                              ELSE 0 END
                    ELSE (SELECT count(*)::int FROM integration_events e
                           WHERE e.store_id = b.store_id AND e.batch_id = b.id
                             AND e.status <> 'RECEIVED') END AS "processedCount"
          FROM import_batches b
         WHERE b.store_id = ${actor.storeId}::uuid
           AND (${only}::uuid IS NULL OR b.id = ${only}::uuid)
           AND (${cursor}::uuid IS NULL OR (b.created_at, b.id) <
                (SELECT created_at, id FROM import_batches
                  WHERE store_id = ${actor.storeId}::uuid AND id = ${cursor}::uuid))
         ORDER BY b.created_at DESC, b.id DESC
         LIMIT ${limit + 1}`;
      const items = rows.map((r) => ({
        ...r,
        issuesCount: r.errors.length,
        errors: r.errors.map((e) => ({ externalEventId: e.externalId, message: e.code })),
      }));
      if (id) {
        if (!items[0]) throw new ApplicationError('NOT_FOUND', 'Importação não encontrada.', 404);
        return items[0];
      }
      return page(items, limit);
    });
  }
  reprocess(actor: TenantActor, key: string, id: string) {
    requireRole(actor, ['OWNER', 'MANAGER']);
    const { storeId, userId } = actor;
    return this.prisma.tenant(storeId, (tx) =>
      command(tx, storeId, userId, 'import.reprocess', key, { id }, async () => {
        const row = await tx.import_batches.findFirst({
          where: { store_id: storeId, id },
          select: { kind: true },
        });
        if (!row) throw new ApplicationError('NOT_FOUND', 'Importação não encontrada.', 404);
        if (row.kind === 'CATALOG')
          throw new ApplicationError(
            'NEW_CATALOG_BATCH_REQUIRED',
            'Envie uma nova versão do catálogo para atualizar os produtos.',
          );
        await tx.import_batches.updateMany({
          where: { store_id: storeId, id },
          data: { status: 'RECEIVED' },
        });
        await this.jobs.send(tx, storeId, 'import.process', { batchId: id });
        await audit(tx, storeId, userId, 'import.reprocess', id);
        return { id, status: 'RECEIVED' };
      }),
    );
  }
}
