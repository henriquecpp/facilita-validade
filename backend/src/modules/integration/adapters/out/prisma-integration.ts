import { randomUUID, randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import {
  ApplicationError,
  type TenantActor,
  requireRole,
} from '../../../../shared/domain/context.js';
import type { PrismaDatabase, PrismaTx } from '../../../../shared/infrastructure/prisma.js';
import type { Jobs } from '../../../../shared/infrastructure/jobs.js';
import { audit, command, hashPayload } from '../../../../shared/infrastructure/commands.js';
import { isDataConflict } from '../../../../shared/infrastructure/database-errors.js';
import { instantSql } from '../../../../shared/infrastructure/instants.js';
import { toJson } from '../../../../shared/infrastructure/json.js';
import type { PrismaInventory } from '../../../inventory/adapters/out/prisma-inventory.js';
import type { ProductDetails } from '../../domain/erp-report.js';
import {
  classifyMovementTime,
  timestampMicros,
  type InventoryMovement,
} from '../../../inventory/domain/index.js';
export interface IntegrationActor {
  storeId: string;
  connectionId: string;
  scopes: string[];
}
export interface CatalogProduct {
  externalProductId: string;
  description: string;
  barcodes: string[];
  active?: boolean;
  photoUrl?: string;
  /** Grupo, categoria, preço de venda e a linha da origem, quando ela os manda (Pagonet). */
  details?: ProductDetails;
  /** Resumo do produto como veio da origem, para a próxima leitura pular o que não mudou. */
  hash?: string;
}
export interface MovementInput {
  externalEventId: string;
  externalProductId: string;
  type: 'SALE' | 'SCRAP' | 'RETURN_RECEIPT' | 'VOID_MOVEMENT';
  occurredAt: string;
  quantity?: number;
  expiresOn?: string | null;
  lotCode?: string | null;
  stockRecordId?: string | null;
  originalExternalEventId?: string | null;
}
export interface BatchInput {
  externalBatchId: string;
  products?: CatalogProduct[];
  events?: MovementInput[];
  periodStart?: string;
  periodEnd?: string;
  completeThrough?: string;
}
interface Batch {
  id: string;
  connection_id: string;
  kind: 'CATALOG' | 'MOVEMENTS';
  payload: BatchInput;
  status: string;
}
export function stableId(...parts: string[]) {
  const h = createHash('sha256')
    .update(JSON.stringify(['controle-estoque:v1', ...parts]))
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
const keyHash = (value: string) => createHash('sha256').update(value).digest('hex');
const eventConflict = () =>
  new ApplicationError('EVENT_CONFLICT', 'Evento já recebido com outro conteúdo.', 409);
/**
 * Janela da recuperação: no máximo um job de recuperação por lote ou produto a cada 15
 * minutos. O pg-boss desiste de um job depois de 5 tentativas em cerca de um minuto; sem a
 * recuperação o lote ficaria parado para sempre, e sem a janela uma falha que se repete
 * geraria um job novo a cada varredura.
 */
const RECOVERY = { singletonSeconds: 900 } as const;
export class PrismaIntegration {
  constructor(
    readonly prisma: PrismaDatabase,
    readonly jobs: Jobs,
    readonly inventory: PrismaInventory,
  ) {}
  async authenticate(value: string | undefined, scope: string): Promise<IntegrationActor> {
    const [selector, secret] = value?.replace(/^Bearer /, '').split('.') ?? [];
    if (!selector || !secret)
      throw new ApplicationError('UNAUTHORIZED', 'Credencial de integração inválida.', 401);
    const [row] = await this.prisma.auth.$queryRaw<
      { store_id: string; connection_id: string; secret_hash: string; scopes: string[] }[]
    >`SELECT store_id, connection_id, secret_hash, scopes FROM auth.resolve_api_key(${selector})`;
    const digest = keyHash(secret);
    if (
      !row ||
      row.secret_hash.length !== digest.length ||
      !timingSafeEqual(Buffer.from(row.secret_hash), Buffer.from(digest))
    )
      throw new ApplicationError('UNAUTHORIZED', 'Credencial de integração inválida.', 401);
    if (!row.scopes.includes(scope))
      throw new ApplicationError('FORBIDDEN', 'Escopo não autorizado.', 403);
    return { storeId: row.store_id, connectionId: row.connection_id, scopes: row.scopes };
  }
  connections(actor: TenantActor) {
    requireRole(actor, ['OWNER']);
    return this.prisma.tenant(actor.storeId, async (tx) => ({
      items: await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT c.id, c.name, c.active,
               COALESCE((SELECT jsonb_agg(jsonb_build_object('id', k.id, 'scopes', k.scopes,
                                                             'revokedAt', k.revoked_at))
                           FROM integration_keys k
                          WHERE k.store_id = c.store_id AND k.connection_id = c.id),
                        '[]'::jsonb) AS keys
          FROM integration_connections c
         WHERE store_id = ${actor.storeId}::uuid
         ORDER BY name`,
      nextCursor: null,
    }));
  }
  createConnection(actor: TenantActor, key: string, name: string) {
    requireRole(actor, ['OWNER']);
    const { storeId, userId } = actor;
    return this.prisma.tenant(storeId, (tx) =>
      command(tx, storeId, userId, 'integration.connection.create', key, { name }, async () => {
        const id = randomUUID();
        await tx.integration_connections.create({
          data: { id, store_id: storeId, name },
          select: { id: true },
        });
        await audit(tx, storeId, userId, 'integration.connection.create', id);
        return { id, name, active: true };
      }),
    );
  }
  async createKey(actor: TenantActor, connectionId: string, scopes: string[]) {
    requireRole(actor, ['OWNER']);
    const secret = randomBytes(32).toString('base64url');
    const selector = randomBytes(12).toString('hex');
    const { storeId, userId } = actor;
    return this.prisma.tenant(storeId, async (tx) => {
      const connection = await tx.integration_connections.findFirst({
        where: { store_id: storeId, id: connectionId, active: true },
        select: { id: true },
      });
      if (!connection) throw new ApplicationError('NOT_FOUND', 'Conexão não encontrada.', 404);
      const id = randomUUID();
      await tx.integration_keys.create({
        data: {
          id,
          store_id: storeId,
          connection_id: connectionId,
          selector,
          secret_hash: keyHash(secret),
          scopes,
        },
        select: { id: true },
      });
      await audit(tx, storeId, userId, 'integration.key.create', id);
      return { id, connectionId, key: `${selector}.${secret}`, scopes };
    });
  }
  async revoke(actor: TenantActor, id: string, connection = false) {
    requireRole(actor, ['OWNER']);
    const { storeId, userId } = actor;
    return this.prisma.tenant(storeId, async (tx) => {
      const { count } = connection
        ? await tx.integration_connections.updateMany({
            where: { store_id: storeId, id },
            data: { active: false },
          })
        : {
            count: await tx.$executeRaw`
              UPDATE integration_keys SET revoked_at = clock_timestamp()
               WHERE store_id = ${storeId}::uuid AND id = ${id}::uuid`,
          };
      if (!count) throw new ApplicationError('NOT_FOUND', 'Credencial não encontrada.', 404);
      await audit(
        tx,
        storeId,
        userId,
        connection ? 'integration.connection.deactivate' : 'integration.key.revoke',
        id,
      );
      return { id };
    });
  }
  ingest(actor: IntegrationActor, kind: Batch['kind'], input: BatchInput) {
    const { storeId, connectionId } = actor;
    return this.prisma.tenant(storeId, async (tx) => {
      const hash = hashPayload(input);
      // Reenvios concorrentes do mesmo lote esperam um pelo outro em vez de colidir.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${storeId}:${connectionId}:${input.externalBatchId}`}, 0))`;
      const old = await tx.import_batches.findUnique({
        where: {
          store_id_connection_id_external_batch_id: {
            store_id: storeId,
            connection_id: connectionId,
            external_batch_id: input.externalBatchId,
          },
        },
        select: { id: true, payload_hash: true, status: true },
      });
      if (old) {
        if (old.payload_hash !== hash)
          throw new ApplicationError('BATCH_CONFLICT', 'Lote já recebido com outro conteúdo.', 409);
        return { id: old.id, status: old.status };
      }
      const id = randomUUID();
      await tx.import_batches.create({
        data: {
          id,
          store_id: storeId,
          connection_id: connectionId,
          external_batch_id: input.externalBatchId,
          payload_hash: hash,
          kind,
          payload: toJson(input),
        },
        select: { id: true },
      });
      // Os eventos do lote de uma vez (até 1.000): a trava de cada um, na mesma ordem em todo
      // lote, faz reenvios concorrentes do mesmo evento esperarem um pelo outro.
      const events = new Map<string, { id: string; hash: string; payload: string }>();
      for (const event of input.events ?? []) {
        const hash = hashPayload(event);
        const seen = events.get(event.externalEventId);
        if (seen && seen.hash !== hash) throw eventConflict();
        events.set(event.externalEventId, {
          id: stableId(storeId, connectionId, event.externalEventId),
          hash,
          payload: JSON.stringify(event),
        });
      }
      if (events.size) {
        const externals = [...events.keys()];
        const rows = [...events.values()];
        await tx.$queryRaw`
          SELECT count(pg_advisory_xact_lock(hashtextextended(id, 0)))
            FROM (SELECT id FROM unnest(${rows.map((row) => row.id)}::text[]) id ORDER BY id) ids`;
        const previous = await tx.$queryRaw<{ external_event_id: string; payload_hash: string }[]>`
          SELECT external_event_id, payload_hash FROM integration_events
           WHERE store_id = ${storeId}::uuid AND connection_id = ${connectionId}::uuid
             AND external_event_id = ANY(${externals}::text[])`;
        if (previous.some((row) => events.get(row.external_event_id)!.hash !== row.payload_hash))
          throw eventConflict();
        await tx.$executeRaw`
          INSERT INTO integration_events(id, store_id, connection_id, batch_id, external_event_id,
                                         payload_hash, payload)
          SELECT e.id, ${storeId}::uuid, ${connectionId}::uuid, ${id}::uuid, e.external,
                 e.hash, e.payload
            FROM unnest(${rows.map((row) => row.id)}::uuid[], ${externals}::text[],
                        ${rows.map((row) => row.hash)}::text[],
                        ${rows.map((row) => row.payload)}::jsonb[]) AS e(id, external, hash, payload)
          ON CONFLICT (store_id, connection_id, external_event_id) DO NOTHING`;
      }
      await this.jobs.send(tx, storeId, 'import.process', { batchId: id });
      return { id, status: 'RECEIVED' };
    });
  }
  async process(storeId: string, batchId: string) {
    const found = await this.prisma.tenant(storeId, (tx) =>
      tx.import_batches.findFirst({
        where: { store_id: storeId, id: batchId },
        select: { id: true, connection_id: true, kind: true, payload: true, status: true },
      }),
    );
    if (!found || found.status === 'COMPLETED') return;
    const batch = found as unknown as Batch;
    await this.prisma.tenant(storeId, (tx) =>
      tx.import_batches.updateMany({
        where: { store_id: storeId, id: batchId },
        data: { status: 'PROCESSING', completed_at: null },
      }),
    );
    const errors: { externalId: string; code: string }[] = [];
    if (batch.kind === 'CATALOG') {
      // Dois passos: primeiro os produtos, cada um sem os códigos que saíram dele; depois os
      // códigos novos. Um código que mudou de produto no ERP já está livre quando o novo dono
      // o recebe, qualquer que seja a ordem no lote. Código que segue com produto de outra
      // conexão é conflito só dele: o produto e os outros códigos são gravados.
      const saved = new Map<string, string>();
      for (const product of batch.payload.products ?? []) {
        try {
          saved.set(
            product.externalProductId,
            await this.prisma.tenant(storeId, (tx) =>
              this.saveProduct(tx, storeId, batch.connection_id, product),
            ),
          );
        } catch (error) {
          if (!isDataConflict(error)) throw error;
          errors.push({ externalId: product.externalProductId, code: 'CATALOG_CONFLICT' });
        }
      }
      for (const product of batch.payload.products ?? []) {
        const id = saved.get(product.externalProductId);
        if (!id) continue;
        const conflicts = await this.prisma.tenant(storeId, (tx) =>
          this.addBarcodes(tx, storeId, id, product.barcodes),
        );
        if (conflicts.length)
          errors.push({ externalId: product.externalProductId, code: 'CATALOG_CONFLICT' });
      }
    } else {
      const events = (batch.payload.events ?? [])
        .slice()
        .sort(
          (a, b) =>
            a.externalProductId.localeCompare(b.externalProductId) ||
            Number(a.type === 'VOID_MOVEMENT') - Number(b.type === 'VOID_MOVEMENT') ||
            a.externalEventId.localeCompare(b.externalEventId),
        );
      const groups = new Map<string, MovementInput[]>();
      for (const event of events)
        groups.set(event.externalProductId, [
          ...(groups.get(event.externalProductId) ?? []),
          event,
        ]);
      // Um produto com falha não segura a baixa dos outros: os grupos seguem e, no fim, o lote
      // falha para o job tentar de novo. Reprocessar não muda os grupos já aceitos.
      let failure: unknown;
      for (const group of groups.values())
        await this.prisma
          .tenant(storeId, async (tx) => {
            const product = await tx.products.findFirst({
              where: {
                store_id: storeId,
                integration_connection_id: batch.connection_id,
                external_product_id: group[0]!.externalProductId,
              },
              select: { id: true },
            });
            if (product) await this.inventory.lock(tx, storeId, product.id);
            // O relógio do banco, o mesmo da reconstrução: com o do processo, um evento que o
            // banco ainda considera futuro seria gravado como fato e ficaria sem aplicar.
            const now = timestampMicros(await this.inventory.now(tx));
            const ids = group.map((event) =>
              stableId(storeId, batch.connection_id, event.externalEventId),
            );
            const received = new Map(
              (
                await tx.$queryRaw<{ id: string; received_at: string }[]>`
                  SELECT id, ${instantSql('received_at')} AS received_at FROM integration_events
                   WHERE store_id = ${storeId}::uuid AND id = ANY(${ids}::uuid[])`
              ).map((row) => [row.id, row.received_at]),
            );
            // Os fatos aceitos são gravados juntos; antes de conferir um cancelamento, os
            // anteriores do grupo já estão gravados (o original pode estar entre eles).
            const accepted: InventoryMovement[] = [];
            const flush = async () => {
              if (!product || !accepted.length) return;
              await this.inventory.appendFacts(tx, storeId, product.id, accepted.splice(0));
            };
            const statuses: string[] = [];
            for (const [index, event] of group.entries()) {
              const eventId = ids[index]!;
              let status = 'ACCEPTED';
              if (!product) status = 'PENDING_PRODUCT';
              else {
                try {
                  classifyMovementTime(event.occurredAt, received.get(eventId)!);
                } catch {
                  status = 'INVALID_EVENT_TIME';
                }
                if (status === 'ACCEPTED' && timestampMicros(event.occurredAt) > now)
                  status = 'PENDING_FUTURE';
                if (
                  status === 'ACCEPTED' &&
                  event.type !== 'VOID_MOVEMENT' &&
                  (!Number.isInteger(event.quantity) ||
                    event.quantity! <= 0 ||
                    event.quantity! > 1000000000)
                )
                  status = 'UNSUPPORTED_QUANTITY';
                if (status === 'ACCEPTED' && event.type === 'VOID_MOVEMENT') {
                  await flush();
                  status = await this.voidStatus(
                    tx,
                    storeId,
                    batch.connection_id,
                    product.id,
                    event,
                  );
                }
                if (status === 'ACCEPTED') {
                  const base = {
                    id: eventId,
                    storeId,
                    productId: product.id,
                    occurredAt: event.occurredAt,
                    source: {
                      kind: 'ERP' as const,
                      connectionId: batch.connection_id,
                      externalEventId: event.externalEventId,
                    },
                  };
                  let movement: InventoryMovement;
                  if (event.type === 'VOID_MOVEMENT')
                    movement = {
                      ...base,
                      type: 'VOID_MOVEMENT',
                      originalMovementId: stableId(
                        storeId,
                        batch.connection_id,
                        event.originalExternalEventId!,
                      ),
                    };
                  else if (event.type === 'SALE')
                    movement = { ...base, type: 'SALE', quantity: event.quantity! };
                  else if (event.type === 'SCRAP')
                    movement = {
                      ...base,
                      type: 'SCRAP',
                      quantity: event.quantity!,
                      identification: {
                        stockRecordId: event.stockRecordId ?? undefined,
                        lotCode: event.lotCode ?? undefined,
                        expiresOn: event.expiresOn ?? undefined,
                      },
                    };
                  else
                    movement = {
                      ...base,
                      type: 'RETURN_RECEIPT',
                      quantity: event.quantity!,
                      stockRecordId: stableId(
                        storeId,
                        batch.connection_id,
                        event.externalEventId,
                        'stock',
                      ),
                      expiresOn: event.expiresOn ?? undefined,
                      lotCode: event.lotCode ?? undefined,
                    };
                  accepted.push(movement);
                }
              }
              statuses.push(status);
              if (status !== 'ACCEPTED')
                errors.push({ externalId: event.externalEventId, code: status });
            }
            await flush();
            await tx.$executeRaw`
              UPDATE integration_events e
                 SET status = u.status,
                     error_code = CASE WHEN u.status = 'ACCEPTED' THEN NULL ELSE u.status END
                FROM unnest(${ids}::uuid[], ${statuses}::text[]) AS u(id, status)
               WHERE e.store_id = ${storeId}::uuid AND e.id = u.id`;
            // Canonical acceptance and its projection commit together. A completed batch never precedes its own stock update.
            // Sem fato novo não há o que aplicar: reprocessar o lote não reconstrói o produto.
            if (product) await this.inventory.rebuildIfStale(tx, storeId, product.id);
          })
          .catch((error: unknown) => {
            console.error(
              'import_product_failed',
              JSON.stringify({
                storeId,
                batchId,
                externalProductId: group[0]!.externalProductId,
                error: error instanceof Error ? error.message : String(error),
              }),
            );
            failure ??= error;
          });
      if (failure) throw failure;
    }
    await this.prisma.tenant(
      storeId,
      (tx) =>
        tx.$executeRaw`
        UPDATE import_batches
           SET status = ${errors.length ? 'COMPLETED_WITH_ISSUES' : 'COMPLETED'},
               errors = ${JSON.stringify(errors)}::jsonb, completed_at = clock_timestamp()
         WHERE store_id = ${storeId}::uuid AND id = ${batchId}::uuid`,
    );
  }
  /** A void only becomes canonical after a valid, physical original is canonical too. */
  async voidStatus(
    tx: PrismaTx,
    storeId: string,
    connectionId: string,
    productId: string,
    event: MovementInput,
  ): Promise<string> {
    if (!event.originalExternalEventId) return 'REFERENCE_REQUIRED';
    if (event.originalExternalEventId === event.externalEventId) return 'INVALID_VOID_REFERENCE';
    const originalId = stableId(storeId, connectionId, event.originalExternalEventId);
    const incoming = await tx.integration_events.findFirst({
      where: { store_id: storeId, connection_id: connectionId, id: originalId },
      select: { payload: true },
    });
    const incomingPayload = incoming?.payload as unknown as MovementInput | undefined;
    const physicalTypes = ['SALE', 'SCRAP', 'RETURN_RECEIPT'];
    if (
      incomingPayload &&
      (!physicalTypes.includes(incomingPayload.type) ||
        incomingPayload.externalProductId !== event.externalProductId)
    )
      return 'INVALID_VOID_REFERENCE';
    const original = await tx.stock_movements.findFirst({
      where: { store_id: storeId, id: originalId },
      select: { product_id: true, payload: true },
    });
    if (!original) return 'PENDING_REFERENCE';
    const fact = original.payload as unknown as InventoryMovement;
    if (
      original.product_id !== productId ||
      fact.productId !== productId ||
      !physicalTypes.includes(fact.type) ||
      fact.source.kind !== 'ERP' ||
      fact.source.connectionId !== connectionId
    )
      return 'INVALID_VOID_REFERENCE';
    return 'ACCEPTED';
  }
  /** Produto do catálogo com os códigos atuais; devolve os que pertencem a outro produto. */
  async upsertProduct(tx: PrismaTx, storeId: string, connectionId: string, input: CatalogProduct) {
    const id = await this.saveProduct(tx, storeId, connectionId, input);
    return this.addBarcodes(tx, storeId, id, input.barcodes);
  }
  /** Grava o produto e tira dele os códigos que o catálogo não lista mais. */
  async saveProduct(tx: PrismaTx, storeId: string, connectionId: string, input: CatalogProduct) {
    const id = stableId(storeId, connectionId, input.externalProductId, 'product');
    const details = input.details;
    await tx.$executeRaw`
      INSERT INTO products(id, store_id, integration_connection_id, external_product_id, description,
                           photo_url, active, erp_group, erp_category, sale_price, erp_attributes,
                           erp_hash)
      VALUES (${id}::uuid, ${storeId}::uuid, ${connectionId}::uuid, ${input.externalProductId},
              ${input.description}, ${input.photoUrl ?? null}, ${input.active ?? true},
              ${details?.group ?? null}, ${details?.category ?? null},
              ${details?.salePrice ?? null}::numeric,
              ${details?.attributes ? JSON.stringify(details.attributes) : null}::jsonb,
              ${input.hash ?? null})
      ON CONFLICT (store_id, integration_connection_id, external_product_id)
      DO UPDATE SET description = excluded.description, photo_url = excluded.photo_url,
                    active = excluded.active, erp_group = excluded.erp_group,
                    erp_category = excluded.erp_category, sale_price = excluded.sale_price,
                    erp_attributes = excluded.erp_attributes, erp_hash = excluded.erp_hash`;
    await tx.$executeRaw`
      INSERT INTO product_inventory(store_id, product_id) VALUES (${storeId}::uuid, ${id}::uuid)
      ON CONFLICT DO NOTHING`;
    await tx.$executeRaw`
      DELETE FROM product_barcodes
       WHERE store_id = ${storeId}::uuid AND product_id = ${id}::uuid
         AND NOT (barcode = ANY(${[...new Set(input.barcodes)]}::text[]))`;
    return id;
  }
  /** Acrescenta os códigos que faltam; devolve os que já são de outro produto. */
  async addBarcodes(tx: PrismaTx, storeId: string, productId: string, barcodes: string[]) {
    const conflicts: string[] = [];
    for (const barcode of new Set(barcodes)) {
      const [owner] = await tx.$queryRaw<{ product_id: string }[]>`
        WITH added AS (
          INSERT INTO product_barcodes(store_id, product_id, barcode)
          VALUES (${storeId}::uuid, ${productId}::uuid, ${barcode})
          ON CONFLICT (store_id, barcode) DO NOTHING
          RETURNING product_id)
        SELECT product_id FROM added
        UNION ALL
        SELECT product_id FROM product_barcodes
         WHERE store_id = ${storeId}::uuid AND barcode = ${barcode}
        LIMIT 1`;
      if (owner?.product_id !== productId) conflicts.push(barcode);
    }
    return conflicts;
  }
  async recover(storeId: string) {
    await this.prisma.tenant(storeId, async (tx) => {
      // Só lotes que podem avançar: o produto que faltava chegou ao catálogo, o original
      // do cancelamento foi aceito, ou o evento futuro chegou à hora. Uma pendência que
      // não mudou seria reprocessada a cada varredura, para sempre, sem efeito.
      const batches = await tx.$queryRaw<{ batch_id: string }[]>`
        SELECT DISTINCT e.batch_id FROM integration_events e
         WHERE e.store_id = ${storeId}::uuid
           -- Só as pendentes, pelo índice parcial: a tabela tem um evento por item vendido.
           AND e.status IN ('PENDING_PRODUCT', 'PENDING_REFERENCE', 'PENDING_FUTURE')
           AND ((e.status = 'PENDING_PRODUCT'
                 AND EXISTS (SELECT 1 FROM products p
                              WHERE p.store_id = e.store_id
                                AND p.integration_connection_id = e.connection_id
                                AND p.external_product_id = e.payload->>'externalProductId'))
                OR (e.status = 'PENDING_REFERENCE'
                    AND EXISTS (SELECT 1 FROM integration_events o
                                 WHERE o.store_id = e.store_id
                                   AND o.connection_id = e.connection_id
                                   AND o.external_event_id = e.payload->>'originalExternalEventId'
                                   AND o.status = 'ACCEPTED'))
                OR (e.status = 'PENDING_FUTURE'
                    AND (e.payload->>'occurredAt')::timestamptz <= clock_timestamp()))
         LIMIT 100`;
      // Lotes parados: recebidos ou em processamento há mais de 15 minutos, mais que a
      // expiração de um job. Um job que esgotou as tentativas não volta sozinho.
      const stuck = await tx.$queryRaw<{ batch_id: string }[]>`
        SELECT id AS batch_id FROM import_batches
         WHERE store_id = ${storeId}::uuid AND status IN ('RECEIVED', 'PROCESSING')
           AND created_at < clock_timestamp() - interval '15 minutes'
         LIMIT 100`;
      for (const b of [...batches, ...stuck])
        await this.jobs.send(
          tx,
          storeId,
          'import.process',
          { batchId: b.batch_id },
          { ...RECOVERY, singletonKey: b.batch_id },
        );
      const stale = await tx.$queryRaw<{ product_id: string }[]>`
        SELECT product_id FROM product_inventory
         WHERE store_id = ${storeId}::uuid AND input_revision > applied_input_revision
         LIMIT 100`;
      for (const p of stale)
        await this.jobs.send(
          tx,
          storeId,
          'inventory.rebuild',
          { productId: p.product_id },
          { ...RECOVERY, singletonKey: p.product_id },
        );
    });
  }
  batch(actor: IntegrationActor, id: string) {
    return this.prisma.tenant(actor.storeId, async (tx) => {
      const [row] = await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT id, status, errors, ${instantSql('created_at')} AS "createdAt",
               ${instantSql('completed_at')} AS "completedAt"
          FROM import_batches
         WHERE store_id = ${actor.storeId}::uuid AND connection_id = ${actor.connectionId}::uuid
           AND id = ${id}::uuid`;
      if (!row) throw new ApplicationError('NOT_FOUND', 'Importação não encontrada.', 404);
      return row;
    });
  }
}
