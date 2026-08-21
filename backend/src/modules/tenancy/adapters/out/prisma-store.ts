import { randomUUID } from 'node:crypto';
import type { PrismaDatabase, PrismaTx } from '../../../../shared/infrastructure/prisma.js';
import { countedLots, NO_LEVEL } from '../../../inventory/adapters/out/lot-levels.js';
import { normalizeRecipients } from '../../../notifications/domain/digest.js';
import { salesFreshness } from '../../../integration/adapters/out/sales-freshness.js';
import type { ListOptions } from '../../../../shared/domain/pagination.js';
import { page } from '../../../../shared/infrastructure/pagination.js';
import type { Jobs } from '../../../../shared/infrastructure/jobs.js';
import { command, audit } from '../../../../shared/infrastructure/commands.js';
import { civilDateOrNull, iso, isoOrNull } from '../../../../shared/infrastructure/instants.js';
import {
  ApplicationError,
  requireRole,
  type TenantActor,
} from '../../../../shared/domain/context.js';
import { validateLevels, type ExpiryLevelInput } from '../../domain/expiry-levels.js';
import { ALWAYS_ALERT_DAYS } from '../../../inventory/domain/sales-forecast.js';
/** Semanas à frente no gráfico do que vai vencer, no Início. */
const UPCOMING_WEEKS = 6;
/** Valor em R$ com centavos, sem resto de ponto flutuante. */
const money = (value: number) => Math.round(value * 100) / 100;
export interface SettingsInput {
  expectedVersion: number;
  timezone: string;
  /** Omitido: mantém o valor atual. */
  alertEmails?: string[];
  digestHour?: number;
  /** Omitido: mantém o valor atual. */
  salesForecastAlerts?: boolean;
}
export interface LevelsInput {
  expectedVersion: number;
  levels: ExpiryLevelInput[];
}
export class PrismaStore {
  constructor(
    readonly prisma: PrismaDatabase,
    readonly jobs: Jobs,
    /** Canais de aviso configurados no servidor, ex.: `email` quando há SMTP. */
    readonly notificationChannels: readonly string[] = [],
  ) {}
  private async readSettings(tx: PrismaTx, storeId: string) {
    const settings = await tx.store_settings.findUnique({
      where: { store_id: storeId },
      select: {
        version: true,
        alert_emails: true,
        digest_hour: true,
        sales_forecast_alerts: true,
        stores: { select: { timezone: true } },
      },
    });
    if (!settings) return undefined;
    const lastDigest = await tx.notification_deliveries.findFirst({
      where: { store_id: storeId, channel: 'email' },
      orderBy: { digest_date: 'desc' },
      select: { digest_date: true, status: true, updated_at: true, last_error: true },
    });
    return {
      version: settings.version,
      timezone: settings.stores.timezone,
      alertEmails: settings.alert_emails,
      digestHour: settings.digest_hour,
      salesForecastAlerts: settings.sales_forecast_alerts,
      lastDigestDate: civilDateOrNull(lastDigest?.digest_date),
      lastDigestStatus: lastDigest?.status ?? null,
      lastDigestAt: isoOrNull(lastDigest?.updated_at),
      lastDigestError: lastDigest?.last_error ?? null,
      emailAvailable: this.notificationChannels.includes('email'),
    };
  }
  store(storeId: string) {
    return this.prisma.tenant(storeId, async (tx) => {
      const store = await tx.stores.findUnique({
        where: { id: storeId },
        select: { id: true, name: true, cnpj_normalized: true },
      });
      return store ? { id: store.id, name: store.name, cnpj: store.cnpj_normalized } : undefined;
    });
  }
  settings(storeId: string) {
    return this.prisma.tenant(storeId, (tx) => this.readSettings(tx, storeId));
  }
  update(actor: TenantActor, key: string, input: SettingsInput) {
    requireRole(actor, ['OWNER']);
    const { storeId, userId } = actor;
    return this.prisma.tenant(storeId, async (tx) => {
      // O fuso vale pelo banco, que é quem calcula a data local da loja. Validar pelo Intl
      // do Node não basta: ele aceita "-03:00" como UTC−3, e o PostgreSQL lê o mesmo texto
      // como UTC+3 (convenção POSIX). Só nomes IANA que o banco conhece são aceitos.
      const [known] = await tx.$queryRaw<{ ok: number }[]>`
        SELECT 1 AS ok FROM pg_timezone_names WHERE name = ${input.timezone}`;
      if (!known) throw new ApplicationError('INVALID_TIMEZONE', 'Fuso horário inválido.');
      return command(tx, storeId, userId, 'store.settings', key, input, async () => {
        // A versão esperada é a trava otimista: se outra edição passou antes, nada muda.
        const { count } = await tx.store_settings.updateMany({
          where: { store_id: storeId, version: input.expectedVersion },
          data: {
            ...(input.alertEmails ? { alert_emails: normalizeRecipients(input.alertEmails) } : {}),
            ...(typeof input.digestHour === 'number' ? { digest_hour: input.digestHour } : {}),
            ...(typeof input.salesForecastAlerts === 'boolean'
              ? { sales_forecast_alerts: input.salesForecastAlerts }
              : {}),
            version: { increment: 1 },
          },
        });
        if (!count)
          throw new ApplicationError(
            'VERSION_CONFLICT',
            'Configuração alterada. Atualize a página.',
            409,
          );
        await tx.stores.updateMany({ where: { id: storeId }, data: { timezone: input.timezone } });
        await audit(tx, storeId, userId, 'store.settings', storeId, input);
        await this.jobs.send(tx, storeId, 'notifications.evaluate', {});
        return this.readSettings(tx, storeId);
      });
    });
  }
  private async readLevels(tx: PrismaTx, storeId: string) {
    const [settings] = await tx.$queryRaw<{ version: number }[]>`
      SELECT levels_version AS version FROM store_settings WHERE store_id = ${storeId}::uuid`;
    const items = await tx.$queryRaw<
      {
        id: string;
        name: string;
        minDays: number | null;
        maxDays: number | null;
        color: string;
        notify: boolean;
      }[]
    >`SELECT id, name, min_days AS "minDays", max_days AS "maxDays", color, notify
        FROM expiry_levels
       WHERE store_id = ${storeId}::uuid
       ORDER BY min_days NULLS FIRST, max_days NULLS LAST, id`;
    return { version: settings?.version ?? 1, items };
  }
  /** Níveis de urgência da loja, do mais urgente ao mais tranquilo. Todo papel lê. */
  levels(storeId: string) {
    return this.prisma.tenant(storeId, (tx) => this.readLevels(tx, storeId), {
      readOnlySnapshot: true,
    });
  }
  /**
   * Troca a lista inteira de níveis, só o proprietário. Níveis que ficam mantêm o id, e os
   * alertas deles seguem os mesmos; os que saem deixam de existir. Os lotes mudam de nível
   * na hora: as listas calculam o nível na leitura, e os alertas são refeitos em seguida.
   */
  updateLevels(actor: TenantActor, key: string, input: LevelsInput) {
    requireRole(actor, ['OWNER']);
    const levels = validateLevels(input.levels);
    const { storeId, userId } = actor;
    return this.prisma.tenant(storeId, (tx) =>
      command(tx, storeId, userId, 'store.levels', key, input, async () => {
        const { count } = await tx.store_settings.updateMany({
          where: { store_id: storeId, levels_version: input.expectedVersion },
          data: { levels_version: { increment: 1 } },
        });
        if (!count)
          throw new ApplicationError(
            'VERSION_CONFLICT',
            'Os níveis foram alterados. Atualize a página.',
            409,
          );
        const current = new Set(
          (
            await tx.expiry_levels.findMany({ where: { store_id: storeId }, select: { id: true } })
          ).map((level) => level.id),
        );
        for (const level of levels)
          if (level.id && !current.has(level.id))
            throw new ApplicationError(
              'LEVEL_NOT_FOUND',
              'Um dos níveis não existe mais. Atualize a página.',
              409,
            );
        const kept = levels.flatMap((level) => (level.id ? [level.id] : []));
        await tx.expiry_levels.deleteMany({
          where: { store_id: storeId, id: { notIn: kept } },
        });
        for (const level of levels) {
          const data = {
            name: level.name,
            min_days: level.minDays,
            max_days: level.maxDays,
            color: level.color,
            notify: level.notify,
          };
          if (level.id)
            await tx.expiry_levels.updateMany({ where: { store_id: storeId, id: level.id }, data });
          else
            await tx.expiry_levels.create({
              data: { id: randomUUID(), store_id: storeId, ...data },
              select: { id: true },
            });
        }
        await audit(tx, storeId, userId, 'store.levels', storeId, { levels });
        await this.jobs.send(tx, storeId, 'notifications.evaluate', {});
        return this.readLevels(tx, storeId);
      }),
    );
  }
  operation(actor: TenantActor, key: string, operation: string | undefined) {
    return this.prisma.tenant(actor.storeId, async (tx) => {
      // Sem operação não há o que procurar; no Prisma, um filtro `undefined` seria ignorado.
      const row = operation
        ? await tx.command_receipts.findFirst({
            where: {
              store_id: actor.storeId,
              principal_id: actor.userId,
              operation,
              idempotency_key: key,
            },
            select: { operation: true, idempotency_key: true, result: true },
          })
        : null;
      if (!row)
        throw new ApplicationError(
          'OPERATION_UNKNOWN',
          'Ainda não há resultado confirmado para esta operação.',
          404,
        );
      return { operation: row.operation, idempotencyKey: row.idempotency_key, result: row.result };
    });
  }
  auditEvents(actor: TenantActor, options: ListOptions = {}) {
    requireRole(actor, ['OWNER', 'MANAGER']);
    const limit = options.limit ?? 50;
    const cursor = options.cursor ?? null;
    return this.prisma.tenant(actor.storeId, async (tx) => {
      // Paginação por (created_at, id) comparada no banco: o cursor precisa da precisão
      // de microssegundos da coluna, que um `Date` não tem.
      const rows = await tx.$queryRaw<
        {
          id: string;
          action: string;
          actorId: string | null;
          entityId: string | null;
          createdAt: Date;
          details: {
            quantity?: number;
            reason?: string;
            expiresOn?: string;
            previousQuantity?: number;
            previousExpiresOn?: string;
          } | null;
        }[]
      >`SELECT id, action, actor_id AS "actorId", entity_id AS "entityId", created_at AS "createdAt",
               CASE WHEN action IN ('inventory.receipt', 'inventory.write-off', 'inventory.edit',
                                    'inventory.resolve')
                 THEN jsonb_strip_nulls(jsonb_build_object(
                   'quantity', detail->'quantity', 'reason', detail->'reason',
                   'expiresOn', detail->'expiresOn',
                   'previousQuantity', detail->'previous'->'quantity',
                   'previousExpiresOn', detail->'previous'->'expiresOn'))
                 ELSE NULL END AS details
          FROM audit_events
         WHERE store_id = ${actor.storeId}::uuid
           AND (${cursor}::uuid IS NULL OR (created_at, id) <
                (SELECT created_at, id FROM audit_events
                  WHERE store_id = ${actor.storeId}::uuid AND id = ${cursor}::uuid))
         ORDER BY created_at DESC, id DESC
         LIMIT ${limit + 1}`;
      return page(
        rows.map((row) => ({
          ...row,
          details: row.details ?? undefined,
          createdAt: iso(row.createdAt),
        })),
        limit,
      );
    });
  }
  dashboard(actor: TenantActor) {
    const { storeId, userId } = actor;
    return this.prisma.tenant(
      storeId,
      async (tx) => {
        // Uma transação só: os números do painel saem do mesmo snapshot.
        const [row] = await tx.$queryRaw<
          {
            trackedProducts: number;
            openIssues: number;
            unreadNotifications: number;
            lastImportAt: Date | null;
            pendingImports: number;
          }[]
        >`SELECT
          (SELECT count(*)::int FROM product_inventory
            WHERE store_id = ${storeId}::uuid AND tracking_status = 'TRACKED') AS "trackedProducts",
          (SELECT count(*)::int FROM reconciliation_issues
            WHERE store_id = ${storeId}::uuid AND status = 'OPEN') AS "openIssues",
          (SELECT count(*)::int FROM notifications n
            WHERE n.store_id = ${storeId}::uuid AND n.active
              AND NOT EXISTS (SELECT 1 FROM notification_reads r
                               WHERE r.store_id = n.store_id AND r.notification_id = n.id
                                 AND r.user_id = ${userId}::uuid AND r.revision >= n.revision)
          ) AS "unreadNotifications",
          (SELECT max(completed_at) FROM import_batches
            WHERE store_id = ${storeId}::uuid) AS "lastImportAt",
          -- Pendente é o que ainda vai andar sozinho: lote não processado ou com evento à
          -- espera de produto, de referência ou do próprio horário. Erro definitivo não é.
          (SELECT count(*)::int FROM import_batches b
            WHERE b.store_id = ${storeId}::uuid
              AND (b.status IN ('RECEIVED', 'PROCESSING')
                   OR b.id IN (SELECT e.batch_id FROM integration_events e
                                WHERE e.store_id = ${storeId}::uuid
                                  AND e.status IN ('PENDING_PRODUCT', 'PENDING_REFERENCE', 'PENDING_FUTURE')))
          ) AS "pendingImports"`;
        if (!row) return undefined;
        const stock = await this.stockSummary(tx, storeId);
        // Origem que o servidor busca sozinho (Pagonet): até quando as vendas chegaram e se
        // pararam no horário em que a loja vende — aí os saldos ficam acima do real.
        const sales = await salesFreshness(tx, storeId);
        return {
          ...row,
          lastImportAt: isoOrNull(row.lastImportAt),
          salesThroughAt: sales?.throughAt ?? null,
          salesDelayed: sales?.delayed ?? false,
          ...stock,
        };
      },
      { readOnlySnapshot: true },
    );
  }
  /**
   * Os números do estoque no Início: lotes vencidos e a vencer, valores em R$ pelo preço de
   * venda e os gráficos por nível e por semana. Só contam os lotes de {@link countedLots}: com
   * saldo, da contagem atual de produto controlado. Os valores somam em `numeric`, sem erro de
   * arredondamento, e saem em reais com centavos.
   */
  async stockSummary(tx: PrismaTx, storeId: string) {
    // Os lotes que contam uma vez só (o CTE usado três vezes é calculado uma vez), e daí os
    // totais, os níveis e as semanas.
    const [summary] = await tx.$queryRaw<
      {
        totals: {
          atRiskRecords: number;
          expiredRecords: number;
          stockValue: number;
          expiringValue: number;
          expiredValue: number;
          unpricedLots: number;
          sellingInTimeRecords: number;
        };
        by_level: { level_id: string | null; lots: number; units: number; value: number }[];
        weeks: { week: number; lots: number; units: number; value: number }[];
      }[]
    >`WITH lots AS (${countedLots(storeId)}),
      totals AS (
        SELECT count(*) FILTER (WHERE days >= 0 AND level_notify)::int AS "atRiskRecords",
               -- Dos lotes a vencer, os que a previsão diz que vendem antes da validade.
               count(*) FILTER (WHERE days >= 0 AND level_notify AND forecast_leftover = 0
                                AND days > ${ALWAYS_ALERT_DAYS}::int)::int AS "sellingInTimeRecords",
               count(*) FILTER (WHERE days < 0)::int AS "expiredRecords",
               COALESCE(sum(quantity * sale_price), 0)::float8 AS "stockValue",
               COALESCE(sum(quantity * sale_price) FILTER (WHERE days >= 0 AND level_notify), 0)::float8
                 AS "expiringValue",
               COALESCE(sum(quantity * sale_price) FILTER (WHERE days < 0), 0)::float8 AS "expiredValue",
               count(*) FILTER (WHERE sale_price IS NULL)::int AS "unpricedLots"
          FROM lots),
      by_level AS (
        SELECT level_id, count(*)::int AS lots, sum(quantity)::float8 AS units,
               COALESCE(sum(quantity * sale_price), 0)::float8 AS value
          FROM lots GROUP BY level_id),
      -- Próximas semanas: o que vence em cada uma, para o gráfico do Início.
      weeks AS (
        SELECT days / 7 AS week, count(*)::int AS lots, sum(quantity)::float8 AS units,
               COALESCE(sum(quantity * sale_price), 0)::float8 AS value
          FROM lots WHERE days >= 0 AND days < ${7 * UPCOMING_WEEKS}
         GROUP BY days / 7)
      SELECT (SELECT to_jsonb(t) FROM totals t) AS totals,
             COALESCE((SELECT jsonb_agg(b) FROM by_level b), '[]'::jsonb) AS by_level,
             COALESCE((SELECT jsonb_agg(w) FROM weeks w), '[]'::jsonb) AS weeks`;
    const totals = summary!.totals;
    const byLevel = summary!.by_level;
    const weeks = summary!.weeks;
    const levels = await tx.$queryRaw<{ id: string; name: string; color: string }[]>`
      SELECT id, name, color FROM expiry_levels WHERE store_id = ${storeId}::uuid
       ORDER BY min_days NULLS FIRST, max_days NULLS LAST, id`;
    const level = (id: string | null) => {
      const found = byLevel.find((item) => item.level_id === id);
      return { lots: found?.lots ?? 0, units: found?.units ?? 0, value: money(found?.value ?? 0) };
    };
    const none = level(null);
    return {
      atRiskRecords: totals.atRiskRecords,
      sellingInTimeRecords: totals.sellingInTimeRecords,
      expiredRecords: totals.expiredRecords,
      stockValue: money(totals.stockValue),
      expiringValue: money(totals.expiringValue),
      expiredValue: money(totals.expiredValue),
      unpricedLots: totals.unpricedLots,
      levels: [
        ...levels.map((item) => ({
          levelId: item.id,
          name: item.name,
          color: item.color,
          ...level(item.id),
        })),
        ...(none.lots ? [{ levelId: null, ...NO_LEVEL, ...none }] : []),
      ],
      upcomingWeeks: Array.from({ length: UPCOMING_WEEKS }, (_, week) => {
        const found = weeks.find((item) => item.week === week);
        return {
          fromDays: week * 7,
          toDays: week * 7 + 6,
          lots: found?.lots ?? 0,
          units: found?.units ?? 0,
          value: money(found?.value ?? 0),
        };
      }),
    };
  }
}
