import { randomUUID } from 'node:crypto';
import type { PrismaDatabase } from '../../../../shared/infrastructure/prisma.js';
import { civilDateSql } from '../../../../shared/infrastructure/instants.js';
import { salesFreshness } from '../../../integration/adapters/out/sales-freshness.js';
import type { DigestAlert, DigestSection } from '../../domain/digest.js';
import type { PrismaPush } from './prisma-push.js';
import type {
  DeliveryClaim,
  DeliveryResult,
  DigestRepository,
  DigestSchedule,
} from '../../application/ports.js';

/** Envio em andamento há mais que isso é considerado interrompido e pode ser retomado. */
const STALE_SENDING = '10 minutes';

export class PrismaDigests implements DigestRepository {
  constructor(
    private readonly prisma: PrismaDatabase,
    /** Aparelhos do proprietário inscritos no push, destinatários do canal `push`. */
    private readonly push?: PrismaPush,
  ) {}

  async schedule(storeId: string): Promise<DigestSchedule | null> {
    const schedule = await this.prisma.tenant(storeId, async (tx) => {
      // Data e hora locais calculadas pelo banco, no fuso configurado da loja.
      const [row] = await tx.$queryRaw<
        {
          name: string;
          local_date: string;
          local_hour: number;
          digest_hour: number;
          alert_emails: string[];
        }[]
      >`SELECT s.name, to_char(l.local, 'YYYY-MM-DD') AS local_date,
               extract(hour FROM l.local)::int AS local_hour, c.digest_hour, c.alert_emails
          FROM stores s
          JOIN store_settings c ON c.store_id = s.id
          CROSS JOIN LATERAL (SELECT clock_timestamp() AT TIME ZONE s.timezone AS local) l
         WHERE s.id = ${storeId}::uuid AND s.active`;
      if (!row) return null;
      const sales = await salesFreshness(tx, storeId);
      return {
        salesDelayedThrough: sales?.delayed ? sales.through : null,
        storeName: row.name,
        localDate: row.local_date,
        localHour: row.local_hour,
        digestHour: row.digest_hour,
        recipients: { email: row.alert_emails },
      };
    });
    if (!schedule || !this.push) return schedule;
    return {
      ...schedule,
      recipients: { ...schedule.recipients, push: await this.push.recipients(storeId, true) },
    };
  }

  claim(
    storeId: string,
    channelId: string,
    digestDate: string,
    recipients: readonly string[],
  ): Promise<DeliveryClaim | null> {
    return this.prisma.tenant(storeId, async (tx) => {
      // Só um worker reserva: o envio do dia é criado uma vez, e depois só volta a ser
      // reservado após uma falha com nova tentativa vencida ou um envio interrompido.
      const [row] = await tx.$queryRaw<DeliveryClaim[]>`
        INSERT INTO notification_deliveries
               (id, store_id, channel, kind, digest_date, recipients, status)
        VALUES (${randomUUID()}::uuid, ${storeId}::uuid, ${channelId}, 'DAILY_DIGEST',
                ${digestDate}::date, ${[...recipients]}::text[], 'SENDING')
        ON CONFLICT (store_id, channel, kind, digest_date) DO UPDATE
           SET status = 'SENDING', attempts = notification_deliveries.attempts + 1,
               recipients = excluded.recipients, updated_at = clock_timestamp()
         WHERE (notification_deliveries.status = 'FAILED'
                AND notification_deliveries.next_attempt_at <= clock_timestamp())
            OR (notification_deliveries.status = 'SENDING'
                AND notification_deliveries.updated_at < clock_timestamp() - ${STALE_SENDING}::interval)
        RETURNING id, attempts`;
      return row ?? null;
    });
  }

  activeAlerts(storeId: string): Promise<{ alerts: DigestAlert[]; sections: DigestSection[] }> {
    return this.prisma.tenant(
      storeId,
      async (tx) => {
        const alerts = await tx.$queryRaw<DigestAlert[]>`
          SELECT pr.description AS "productName", ${civilDateSql('sp.expires_on')} AS "expiresOn",
                 sp.quantity::int AS quantity, r.lot_code AS "lotCode",
                 CASE WHEN n.type = 'DEPLETED' THEN 'DEPLETED' ELSE n.level END AS section
            FROM notifications n
            JOIN products pr ON pr.store_id = n.store_id AND pr.id = n.product_id
            JOIN stock_records r ON r.store_id = n.store_id AND r.id = n.record_id
            JOIN stock_projections sp ON sp.store_id = n.store_id AND sp.record_id = n.record_id
           WHERE n.store_id = ${storeId}::uuid AND n.active
           ORDER BY sp.expires_on, pr.description, r.id`;
        const sections = await tx.$queryRaw<DigestSection[]>`
          SELECT id::text AS key, name AS title, COALESCE(max_days < 0, false) AS expired
            FROM expiry_levels
           WHERE store_id = ${storeId}::uuid AND notify
           ORDER BY min_days NULLS FIRST, max_days NULLS LAST, id`;
        return { alerts, sections };
      },
      { readOnlySnapshot: true },
    );
  }

  finish(storeId: string, claim: DeliveryClaim, result: DeliveryResult): Promise<void> {
    const alertCount = result.status === 'SKIPPED' ? 0 : result.alertCount;
    const providerMessageId = result.status === 'SENT' ? (result.providerMessageId ?? null) : null;
    const error = result.status === 'FAILED' ? result.error : null;
    const retryInMinutes = result.status === 'FAILED' ? result.retryInMinutes : null;
    return this.prisma.tenant(storeId, async (tx) => {
      await tx.$executeRaw`
        UPDATE notification_deliveries
           SET status = ${result.status}, alert_count = ${alertCount}::int,
               provider_message_id = ${providerMessageId}, last_error = ${error},
               next_attempt_at = CASE WHEN ${retryInMinutes}::int IS NULL THEN NULL
                                      ELSE clock_timestamp() + make_interval(mins => ${retryInMinutes}::int) END,
               updated_at = clock_timestamp()
         WHERE store_id = ${storeId}::uuid AND id = ${claim.id}::uuid`;
    });
  }
}
