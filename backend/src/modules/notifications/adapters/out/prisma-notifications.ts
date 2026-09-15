import { page } from '../../../../shared/infrastructure/pagination.js';
import { Prisma } from '../../../../generated/prisma/client.js';
import type { PrismaDatabase, PrismaTx } from '../../../../shared/infrastructure/prisma.js';
import { ApplicationError, type TenantActor } from '../../../../shared/domain/context.js';
import { command } from '../../../../shared/infrastructure/commands.js';
import { civilDateSql, instantSql } from '../../../../shared/infrastructure/instants.js';
import { countedLots } from '../../../inventory/adapters/out/lot-levels.js';

/** Produtos por transação na varredura: quanto tempo, no máximo, um produto espera por ela. */
const EVALUATE_GROUP = 250;
/**
 * A chave canônica do evento (`canonicalEventKey` do motor), em SQL: desempata baixas no mesmo
 * instante na mesma ordem da reconstrução. Comparada em ordem binária, como no TypeScript.
 */
const eventKey = Prisma.raw(`CASE WHEN m.payload->'source'->>'kind' = 'ERP'
    THEN '["ERP",' || to_json(m.payload->'source'->>'connectionId')::text || ','
         || to_json(m.payload->'source'->>'externalEventId')::text || ']'
    ELSE '["APP",' || to_json(m.payload->'source'->>'commandId')::text || ']' END`);

export interface NotificationListOptions {
  cursor?: string;
  limit?: number;
  type?: 'EXPIRY' | 'DEPLETED';
  levelId?: string;
}
export class PrismaNotifications {
  constructor(readonly prisma: PrismaDatabase) {}
  /**
   * Recalcula os alertas de um produto ou, sem produto, da loja inteira.
   *
   * A conta é feita no banco, de uma vez para um grupo de produtos: a varredura roda a cada
   * minuto, e uma consulta por produto (milhares por loja) não cabia no minuto. Cada grupo é uma
   * transação curta, com a trava dos produtos dele: entradas, contagens e importações esperam
   * no máximo um grupo. Produto travado agora (reconstrução em andamento) fica fora da
   * varredura: o job que segue toda reconstrução avalia ele logo depois.
   */
  async evaluate(storeId: string, product?: string | readonly string[]) {
    // Produtos que mudaram (o job que segue cada reconstrução, em lotes): esperam a trava.
    if (product !== undefined) {
      const list = typeof product === 'string' ? [product] : [...new Set(product)];
      for (let i = 0; i < list.length; i += EVALUATE_GROUP)
        await this.prisma.tenant(storeId, (tx) =>
          this.evaluateProducts(tx, storeId, list.slice(i, i + EVALUATE_GROUP), false),
        );
      return;
    }
    const products = (
      await this.prisma.tenant(
        storeId,
        (tx) =>
          // Produtos sem contagem não têm registros nem alertas.
          tx.$queryRaw<{ id: string }[]>`
          SELECT product_id AS id FROM product_inventory
           WHERE store_id = ${storeId}::uuid AND tracking_status = 'TRACKED'
           ORDER BY product_id`,
      )
    ).map((row) => row.id);
    for (let i = 0; i < products.length; i += EVALUATE_GROUP)
      await this.prisma.tenant(storeId, (tx) =>
        this.evaluateProducts(tx, storeId, products.slice(i, i + EVALUATE_GROUP), true),
      );
  }
  /**
   * Alertas de um grupo de produtos, sob a trava deles: não se intercala com uma reconstrução.
   * Produto com venda ainda não aplicada fica como está até a reconstrução.
   *
   * - Validade: os lotes que alertam em `countedLots`, a mesma regra das telas (nível que
   *   avisa e, com a opção da loja, sem previsão de vender o lote antes da validade).
   * - Esgotado: lote zerado cuja última baixa, na ordem canônica do motor, foi uma venda dos
   *   últimos 2 dias. Só as baixas desses 2 dias são lidas: se houve uma, a última é dela.
   *
   * Só grava o que muda. Uma mudança de nível, ou a volta de um alerta inativo, vale como alerta
   * novo para quem já o tinha lido (a revisão sobe) e fica pendente de push. Alerta que não vale
   * mais, inclusive o de um lote de contagem anterior, fica inativo.
   */
  async evaluateProducts(tx: PrismaTx, storeId: string, candidates: string[], skipLocked: boolean) {
    const locked = await tx.$queryRaw<{ id: string; since: Date }[]>`
        SELECT product_id AS id, clock_timestamp() - interval '2 days' AS since
          FROM product_inventory
         WHERE store_id = ${storeId}::uuid AND product_id = ANY(${candidates}::uuid[])
           AND tracking_status = 'TRACKED' AND input_revision = applied_input_revision
         ORDER BY product_id
           FOR UPDATE ${Prisma.raw(skipLocked ? 'SKIP LOCKED' : '')}`;
    if (!locked.length) return;
    const products = locked.map((row) => row.id);
    // Início da janela do saldo esgotado, pelo relógio do banco. Como parâmetro, o planejador
    // estima bem as poucas vendas dos 2 dias e vai pelos índices.
    const since = locked[0]!.since;
    await tx.$queryRaw`
      WITH lots AS (
        SELECT l.id, l.product_id, l.quantity, l.days, l.level_id
          FROM (${countedLots(storeId, products)}) l
         WHERE l.alerting
      ), last_out AS (
        SELECT DISTINCT ON (a.record_id) a.record_id, m.product_id, a.quantity,
               m.id AS movement_id, m.payload->>'type' AS type
          FROM stock_movements m
          JOIN movement_allocations a ON a.store_id = m.store_id AND a.movement_id = m.id
          JOIN product_inventory i
            ON i.store_id = m.store_id AND i.product_id = m.product_id AND i.epoch_id = a.epoch_id
          JOIN stock_projections s ON s.store_id = a.store_id AND s.record_id = a.record_id
         WHERE m.store_id = ${storeId}::uuid AND m.product_id = ANY(${products}::uuid[])
           AND m.occurred_at > ${since}::timestamptz AND s.quantity = 0
         ORDER BY a.record_id, m.occurred_at DESC, ${eventKey} COLLATE "C" DESC
      ), desired AS (
        SELECT l.id AS record_id, l.product_id, 'EXPIRY'::text AS type, l.level_id::text AS level,
               format('%s: %s unidades estimadas; %s.', p.description, l.quantity,
                      CASE WHEN l.days < 0 THEN 'validade vencida'
                           ELSE l.days || ' dia(s) para vencer' END) AS message,
               NULL::int AS depleted_quantity, NULL::uuid AS depleted_movement_id
          FROM lots l
          JOIN products p ON p.store_id = ${storeId}::uuid AND p.id = l.product_id
        UNION ALL
        SELECT o.record_id, o.product_id, 'DEPLETED', 'INFO',
               format('%s: última baixa automática de %s unidades no lote %s; saldo estimado esgotado. Confira na gôndola se ainda há unidades.',
                      p.description, o.quantity, COALESCE(r.lot_code, ${civilDateSql('s.expires_on')})),
               o.quantity, o.movement_id
          FROM last_out o
          JOIN stock_records r ON r.store_id = ${storeId}::uuid AND r.id = o.record_id
          JOIN stock_projections s ON s.store_id = r.store_id AND s.record_id = r.id
          JOIN products p ON p.store_id = r.store_id AND p.id = o.product_id
         WHERE o.type = 'SALE'
      ), saved AS (
        INSERT INTO notifications(id, store_id, product_id, record_id, type, level, message,
                                  push_pending, depleted_quantity, depleted_movement_id)
        SELECT gen_random_uuid(), ${storeId}::uuid, product_id, record_id, type, level, message,
               true, depleted_quantity, depleted_movement_id
          FROM desired
        ON CONFLICT (store_id, record_id, type) DO UPDATE
           SET revision = CASE WHEN notifications.level <> excluded.level OR NOT notifications.active
                               THEN notifications.revision + 1 ELSE notifications.revision END,
               push_pending = CASE WHEN notifications.level <> excluded.level OR NOT notifications.active
                                   THEN true ELSE notifications.push_pending END,
               level = excluded.level, message = excluded.message, active = true,
               depleted_quantity = excluded.depleted_quantity,
               depleted_movement_id = excluded.depleted_movement_id
         WHERE notifications.level <> excluded.level OR notifications.message <> excluded.message
            OR notifications.depleted_movement_id IS DISTINCT FROM excluded.depleted_movement_id
            OR NOT notifications.active
        RETURNING 1
      ), cleared AS (
        UPDATE notifications n SET active = false, push_pending = false
         WHERE n.store_id = ${storeId}::uuid AND n.active
           AND n.product_id = ANY(${products}::uuid[])
           AND NOT EXISTS (SELECT 1 FROM desired d
                            WHERE d.record_id = n.record_id AND d.type = n.type)
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM saved)::int AS saved,
             (SELECT count(*) FROM cleared)::int AS cleared`;
  }
  read(actor: TenantActor, key: string, id: string) {
    const { storeId, userId } = actor;
    return this.prisma.tenant(storeId, (tx) =>
      command(tx, storeId, userId, 'notification.read', key, { id }, async () => {
        // Lido na revisão atual: se o alerta mudar de nível depois, volta a ser não lido.
        const rows = await tx.$queryRaw<{ notification_id: string }[]>`
          INSERT INTO notification_reads(store_id, notification_id, user_id, revision)
          SELECT store_id, id, ${userId}::uuid, revision FROM notifications
           WHERE store_id = ${storeId}::uuid AND id = ${id}::uuid
          ON CONFLICT (store_id, notification_id, user_id) DO UPDATE SET revision = excluded.revision
          RETURNING notification_id`;
        if (!rows.length) throw new ApplicationError('NOT_FOUND', 'Alerta não encontrado.', 404);
        return { id };
      }),
    );
  }
  list(storeId: string, userId: string, options: NotificationListOptions = {}) {
    const limit = options.limit ?? 50;
    const type = options.type ?? null;
    const levelId = options.levelId ?? null;
    const cursor = options.cursor ?? null;
    return this.prisma.tenant(storeId, async (tx) =>
      page(
        await tx.$queryRaw<Record<string, unknown>[]>`
          SELECT n.id, n.message AS title, n.message, n.type,
                 CASE WHEN n.type = 'EXPIRY' THEN n.level END AS "levelId",
                 l.name AS "levelName", l.color AS "levelColor", n.product_id AS "productId",
                 p.description AS "productName", ${civilDateSql('s.expires_on')} AS "expiresOn",
                 s.quantity,
                 CASE WHEN nr.revision >= n.revision THEN ${instantSql('n.created_at')} END AS "readAt",
                 ${instantSql('n.created_at')} AS "createdAt"
            FROM notifications n
            JOIN products p ON p.store_id = n.store_id AND p.id = n.product_id
            JOIN stock_projections s ON s.store_id = n.store_id AND s.record_id = n.record_id
            LEFT JOIN expiry_levels l
              ON l.store_id = n.store_id AND n.type = 'EXPIRY' AND l.id::text = n.level
            LEFT JOIN notification_reads nr
              ON nr.store_id = n.store_id AND nr.notification_id = n.id AND nr.user_id = ${userId}::uuid
           WHERE n.store_id = ${storeId}::uuid AND n.active
             AND (${type}::text IS NULL OR n.type = ${type}::text)
             AND (${levelId}::text IS NULL OR n.level = ${levelId}::text)
             AND (${cursor}::uuid IS NULL OR (n.created_at, n.id) <
                  (SELECT created_at, id FROM notifications
                    WHERE store_id = ${storeId}::uuid AND id = ${cursor}::uuid))
           ORDER BY n.created_at DESC, n.id DESC
           LIMIT ${limit + 1}`,
        limit,
      ),
    );
  }
}
