import { randomUUID } from 'node:crypto';
import type { PrismaDatabase, PrismaTx } from '../../../../shared/infrastructure/prisma.js';
import { civilDateSql } from '../../../../shared/infrastructure/instants.js';
import {
  ApplicationError,
  requireRole,
  type TenantActor,
} from '../../../../shared/domain/context.js';
import { lotDays } from '../../../inventory/adapters/out/lot-levels.js';
import {
  buildPushAlert,
  buildPushDigest,
  buildPushLevel,
  type PendingAlert,
  type PushMessage,
} from '../../domain/push.js';
import type {
  ChannelContext,
  NotificationChannel,
  OutboundMessage,
} from '../../application/ports.js';
import type { FcmSender } from './fcm.js';
import { isPushServiceEndpoint, type WebPushSender } from './web-push.js';
import { dueScheduleKeys, type PushPreferencesInput } from '../../domain/schedules.js';
import { readPushPreferences, savePushPreferences } from './push-preferences.js';

export interface SubscriptionInput {
  kind: 'WEB' | 'FCM';
  /** Web Push: a URL do serviço de push. FCM: o token de registro do aparelho. */
  endpoint: string;
  p256dh?: string;
  auth?: string;
}

interface Target {
  id: string;
  kind: 'WEB' | 'FCM';
  endpoint: string;
  p256dh: string | null;
  auth: string | null;
}

/** Falhas seguidas de um aparelho antes de a inscrição ser apagada. */
const MAX_FAILURES = 10;

/**
 * Inscrições de push e envio, só para o proprietário. Cada inscrição vale enquanto a sessão
 * em que foi feita vale e o usuário segue proprietário ativo: sair, ser desconectado ou mudar
 * de papel encerra o envio, mesmo que o aparelho não avise.
 */
export class PrismaPush {
  constructor(
    readonly prisma: PrismaDatabase,
    readonly web: WebPushSender | null = null,
    readonly fcm: FcmSender | null = null,
  ) {}

  get available(): boolean {
    return !!this.web || !!this.fcm;
  }

  preferences(actor: TenantActor) {
    requireRole(actor, ['OWNER']);
    return this.prisma.tenant(actor.storeId, (tx) => readPushPreferences(tx, actor.storeId), {
      readOnlySnapshot: true,
    });
  }

  savePreferences(actor: TenantActor, key: string, input: PushPreferencesInput) {
    return savePushPreferences(this.prisma, actor, key, input);
  }

  /**
   * O que o painel e o coletor precisam para se inscrever; o servidor diz o que tem. Os dados
   * do Firebase são públicos (os mesmos de um google-services.json): o coletor inicia o
   * Firebase com eles, então o mesmo APK serve a qualquer servidor.
   */
  config(actor: TenantActor) {
    const fcm = this.fcm?.config;
    return {
      allowed: actor.role === 'OWNER',
      webPushPublicKey: this.web?.vapid.publicKey ?? null,
      fcmProjectId: fcm?.projectId ?? null,
      fcmAppId: fcm?.client.appId ?? null,
      fcmApiKey: fcm?.client.apiKey ?? null,
      fcmSenderId: fcm?.client.senderId ?? null,
    };
  }

  subscribe(actor: TenantActor, input: SubscriptionInput) {
    requireRole(actor, ['OWNER']);
    if (input.kind === 'WEB') {
      if (!this.web)
        throw new ApplicationError(
          'PUSH_UNAVAILABLE',
          'O servidor não tem Web Push configurado.',
          503,
        );
      if (!isPushServiceEndpoint(input.endpoint) || !input.p256dh || !input.auth)
        throw new ApplicationError('INVALID_SUBSCRIPTION', 'Inscrição de push inválida.');
    } else if (!this.fcm)
      throw new ApplicationError(
        'PUSH_UNAVAILABLE',
        'O servidor não tem o Firebase configurado.',
        503,
      );
    const { storeId, userId, sessionId } = actor;
    const web = input.kind === 'WEB';
    return this.prisma.tenant(storeId, async (tx) => {
      const [row] = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO push_subscriptions(id, store_id, user_id, session_id, kind, endpoint, p256dh, auth)
        VALUES (${randomUUID()}::uuid, ${storeId}::uuid, ${userId}::uuid, ${sessionId}::uuid,
                ${input.kind}, ${input.endpoint}, ${web ? input.p256dh! : null},
                ${web ? input.auth! : null})
        ON CONFLICT (store_id, endpoint) DO UPDATE
           SET user_id = excluded.user_id, session_id = excluded.session_id, kind = excluded.kind,
               p256dh = excluded.p256dh, auth = excluded.auth, failures = 0,
               updated_at = clock_timestamp()
        RETURNING id`;
      return { id: row!.id, kind: input.kind };
    });
  }

  /** Sair do push neste aparelho; qualquer papel, para não deixar inscrição para trás. */
  unsubscribe(actor: TenantActor, endpoint: string) {
    return this.prisma.tenant(actor.storeId, async (tx) => ({
      removed: await tx.$executeRaw`
        DELETE FROM push_subscriptions
         WHERE store_id = ${actor.storeId}::uuid AND endpoint = ${endpoint}`,
    }));
  }

  private targets(tx: PrismaTx, storeId: string, ids: readonly string[] | null = null) {
    return tx.$queryRaw<Target[]>`
      SELECT ps.id, ps.kind, ps.endpoint, ps.p256dh, ps.auth
        FROM push_subscriptions ps
        JOIN auth_sessions s ON s.store_id = ps.store_id AND s.id = ps.session_id
        JOIN store_users u ON u.store_id = ps.store_id AND u.id = ps.user_id
        JOIN stores st ON st.id = ps.store_id
       WHERE ps.store_id = ${storeId}::uuid AND st.active AND u.active AND u.role = 'OWNER'
         AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
         AND (${ids as string[] | null}::uuid[] IS NULL OR ps.id = ANY(${ids as string[] | null}::uuid[]))
       ORDER BY ps.id`;
  }

  /** Aparelhos que recebem agora, para o resumo diário registrar os destinatários. */
  recipients(storeId: string, dailyDigest = false): Promise<string[]> {
    if (!this.available) return Promise.resolve([]);
    return this.prisma.tenant(
      storeId,
      async (tx) => {
        if (dailyDigest && !(await readPushPreferences(tx, storeId)).dailyDigestEnabled) return [];
        return (await this.targets(tx, storeId)).map((target) => target.id);
      },
      { readOnlySnapshot: true },
    );
  }

  /**
   * Envia a todos os aparelhos que recebem (ou só a `ids`). Inscrição cancelada no aparelho é
   * apagada; falha conta, e depois de várias seguidas a inscrição também sai.
   */
  async deliver(storeId: string, message: PushMessage, ids: readonly string[] | null = null) {
    const targets = await this.prisma.tenant(storeId, (tx) => this.targets(tx, storeId, ids), {
      readOnlySnapshot: true,
    });
    let sent = 0;
    let removed = 0;
    const errors: string[] = [];
    for (const target of targets) {
      let outcome: 'SENT' | 'GONE' | 'FAILED';
      try {
        if (target.kind === 'WEB' && this.web)
          outcome = await this.web.send(
            { endpoint: target.endpoint, p256dh: target.p256dh!, auth: target.auth! },
            message,
          );
        else if (target.kind === 'FCM' && this.fcm)
          outcome = await this.fcm.send(target.endpoint, message);
        else continue;
      } catch (error) {
        outcome = 'FAILED';
        errors.push(error instanceof Error ? error.message : String(error));
      }
      await this.prisma.tenant(storeId, async (tx) => {
        if (outcome === 'SENT')
          await tx.$executeRaw`
            UPDATE push_subscriptions SET failures = 0, last_success_at = clock_timestamp()
             WHERE store_id = ${storeId}::uuid AND id = ${target.id}::uuid`;
        else if (outcome === 'GONE')
          await tx.$executeRaw`
            DELETE FROM push_subscriptions
             WHERE store_id = ${storeId}::uuid AND id = ${target.id}::uuid`;
        else
          await tx.$executeRaw`
            WITH failed AS (
              UPDATE push_subscriptions SET failures = failures + 1, updated_at = clock_timestamp()
               WHERE store_id = ${storeId}::uuid AND id = ${target.id}::uuid
              RETURNING id, failures)
            DELETE FROM push_subscriptions
             WHERE store_id = ${storeId}::uuid
               AND id IN (SELECT id FROM failed WHERE failures >= ${MAX_FAILURES})`;
      });
      if (outcome === 'SENT') sent++;
      if (outcome === 'GONE') removed++;
    }
    return { targets: targets.length, sent, removed, errors };
  }

  /**
   * Alertas imediatos consolidados por nível e avisos dos horários escolhidos. Chamado pela
   * varredura do worker a cada minuto, depois de reavaliar os alertas. Sem push no servidor
   * ou sem aparelho inscrito, as pendências são descartadas: ligar o push depois não traz
   * avisos velhos.
   */
  async flush(storeId: string) {
    const alerts = await this.prisma.tenant(storeId, async (tx) => {
      const rows = await tx.$queryRaw<PendingAlert[]>`
        WITH claimed AS (
          SELECT n.id FROM notifications n
          JOIN product_inventory i ON i.store_id = n.store_id AND i.product_id = n.product_id
           WHERE n.store_id = ${storeId}::uuid AND n.push_pending
             AND i.input_revision = i.applied_input_revision
             FOR UPDATE OF n SKIP LOCKED),
        cleared AS (
          UPDATE notifications n SET push_pending = false
            FROM claimed c
           WHERE n.store_id = ${storeId}::uuid AND n.id = c.id
          RETURNING n.id, n.type, n.level, n.product_id, n.record_id, n.active, n.depleted_quantity)
        SELECT c.type, c.product_id AS "productId", p.description AS "productName",
               c.record_id AS "recordId", r.lot_code AS "lotCode", c.level AS "levelId",
               c.depleted_quantity AS "depletedQuantity",
               (SELECT count(*)::int FROM notifications n
                 JOIN stock_projections sp ON sp.store_id = n.store_id AND sp.record_id = n.record_id AND sp.quantity > 0
                 JOIN stock_records sr ON sr.store_id = sp.store_id AND sr.id = sp.record_id
                 JOIN product_inventory pi ON pi.store_id = sr.store_id AND pi.product_id = sr.product_id
                  AND pi.epoch_id = sr.epoch_id AND pi.tracking_status = 'TRACKED'
                  AND pi.input_revision = pi.applied_input_revision
                WHERE n.store_id = ${storeId}::uuid AND n.type = 'EXPIRY' AND n.active AND n.level = c.level) AS "levelLotCount",
               l.name AS "levelName", s.quantity, ${civilDateSql('s.expires_on')} AS "expiresOn",
               d.days
          FROM cleared c
          JOIN products p ON p.store_id = ${storeId}::uuid AND p.id = c.product_id
          JOIN stock_projections s ON s.store_id = ${storeId}::uuid AND s.record_id = c.record_id
          JOIN stock_records r ON r.store_id = s.store_id AND r.id = s.record_id
          JOIN product_inventory i ON i.store_id = r.store_id AND i.product_id = r.product_id
           AND i.epoch_id = r.epoch_id AND i.input_revision = i.applied_input_revision AND i.tracking_status = 'TRACKED'
          JOIN stores st ON st.id = ${storeId}::uuid
          ${lotDays}
          LEFT JOIN expiry_levels l
            ON l.store_id = ${storeId}::uuid AND c.type = 'EXPIRY' AND l.id::text = c.level
          LEFT JOIN level_push_preferences lp ON lp.store_id = l.store_id AND lp.level_id = l.id
          LEFT JOIN push_preferences pp ON pp.store_id = ${storeId}::uuid
         WHERE c.active AND ((c.type = 'EXPIRY' AND l.notify AND COALESCE(lp.immediate, true))
                             OR (c.type = 'DEPLETED' AND COALESCE(pp.depleted_enabled, true)))
         ORDER BY d.days, p.description`;
      return rows;
    });
    const messages: PushMessage[] = [];
    const levels = new Map<string, { name: string; count: number }>();
    for (const alert of alerts) {
      if (alert.type === 'DEPLETED') messages.push(buildPushAlert([alert])!);
      else if (alert.levelId) {
        const group = levels.get(alert.levelId) ?? {
          name: alert.levelName ?? 'Validade',
          count: 0,
        };
        group.count = alert.levelLotCount ?? group.count + 1;
        levels.set(alert.levelId, group);
      }
    }
    for (const [id, level] of levels) messages.push(buildPushLevel(id, level.name, level.count));
    // Se imediato, periódico e diário coincidirem nesta varredura, um push do nível basta.
    const scheduled = await this.claimScheduled(storeId);
    for (const message of scheduled) {
      const duplicate = messages.findIndex((candidate) => candidate.tag === message.tag);
      if (duplicate >= 0) messages[duplicate] = message;
      else messages.push(message);
    }
    if (!messages.length || !this.available) return null;
    const total = { targets: 0, sent: 0, removed: 0, errors: [] as string[] };
    for (const message of messages) {
      const outcome = await this.deliver(storeId, message);
      total.targets += outcome.targets;
      total.sent += outcome.sent;
      total.removed += outcome.removed;
      total.errors.push(...outcome.errors);
    }
    return total;
  }

  /** Reserva por nível e janela local; replay, concorrência e horário repetido no fuso não duplicam. */
  private claimScheduled(storeId: string): Promise<PushMessage[]> {
    return this.prisma.tenant(storeId, async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${storeId}:push-schedules`}, 0))`;
      // Mais que qualquer intervalo (até 24h) e mudança de fuso; evita histórico sem limite.
      await tx.$executeRaw`DELETE FROM push_schedule_claims
        WHERE store_id = ${storeId}::uuid AND created_at < clock_timestamp() - interval '7 days'`;
      const [clock] = await tx.$queryRaw<{ date: string; time: string }[]>`
        SELECT to_char(clock_timestamp() AT TIME ZONE timezone, 'YYYY-MM-DD') AS date,
               to_char(clock_timestamp() AT TIME ZONE timezone, 'HH24:MI') AS time
          FROM stores WHERE id = ${storeId}::uuid AND active`;
      if (!clock) return [];
      const levels = await tx.$queryRaw<
        {
          id: string;
          name: string;
          intervalHours: number | null;
          intervalDue: boolean;
          dailyTime: string | null;
          count: number;
        }[]
      >`
        SELECT l.id, l.name, p.interval_hours AS "intervalHours", p.daily_time AS "dailyTime", count(n.id)::int AS count
             , NOT EXISTS (SELECT 1 FROM push_schedule_claims c WHERE c.store_id = l.store_id AND c.level_id = l.id
                           AND c.schedule_key LIKE 'hours:%'
                           AND c.created_at > clock_timestamp() - make_interval(hours => p.interval_hours)) AS "intervalDue"
          FROM expiry_levels l
          JOIN level_push_preferences p ON p.store_id = l.store_id AND p.level_id = l.id
          JOIN notifications n ON n.store_id = l.store_id AND n.level = l.id::text AND n.type = 'EXPIRY' AND n.active
          JOIN stock_projections s ON s.store_id = n.store_id AND s.record_id = n.record_id AND s.quantity > 0
          JOIN stock_records r ON r.store_id = s.store_id AND r.id = s.record_id
          JOIN product_inventory i ON i.store_id = r.store_id AND i.product_id = r.product_id
           AND i.epoch_id = r.epoch_id AND i.input_revision = i.applied_input_revision AND i.tracking_status = 'TRACKED'
         WHERE l.store_id = ${storeId}::uuid AND l.notify
         GROUP BY l.id, l.name, p.interval_hours, p.daily_time
         ORDER BY l.id`;
      const messages: PushMessage[] = [];
      for (const level of levels) {
        let claimed = false;
        for (const key of dueScheduleKeys(
          { ...level, intervalHours: level.intervalDue ? level.intervalHours : null },
          clock.date,
          clock.time,
        )) {
          const inserted = await tx.$executeRaw`
            INSERT INTO push_schedule_claims(store_id, level_id, schedule_key)
            VALUES (${storeId}::uuid, ${level.id}::uuid, ${key}) ON CONFLICT DO NOTHING`;
          claimed ||= inserted > 0;
        }
        if (claimed) messages.push(buildPushLevel(level.id, level.name, level.count));
      }
      return messages;
    });
  }

  /** Push de teste para os aparelhos do proprietário, para conferir a inscrição. */
  async test(actor: TenantActor) {
    requireRole(actor, ['OWNER']);
    if (!this.available)
      throw new ApplicationError('PUSH_UNAVAILABLE', 'O servidor não tem push configurado.', 503);
    const result = await this.deliver(actor.storeId, {
      title: 'Teste de notificação',
      body: 'Se você recebeu esta mensagem, os avisos de validade chegam neste aparelho.',
      url: '/alerts',
      tag: 'teste',
    });
    if (!result.targets)
      throw new ApplicationError(
        'NO_SUBSCRIPTIONS',
        'Nenhum aparelho do proprietário está inscrito para receber notificações.',
      );
    return { sent: result.sent, targets: result.targets };
  }
}

/** Resumo diário pelo push, como mais um canal do resumo (ao lado do e-mail). */
export class PushChannel implements NotificationChannel {
  readonly id = 'push';
  constructor(readonly push: PrismaPush) {}
  async send(recipients: readonly string[], message: OutboundMessage, context?: ChannelContext) {
    if (!context) throw new Error('O push precisa da loja do envio.');
    const result = await this.push.deliver(
      context.storeId,
      buildPushDigest(context.storeName, message.summary ?? message.subject),
      recipients,
    );
    if (!result.sent)
      throw new Error(result.errors[0] ?? 'Nenhum aparelho inscrito recebeu o push.');
    return {};
  }
}
