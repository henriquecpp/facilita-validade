import { buildAlertDigest, buildTestMessage } from '../domain/digest.js';
import type { DeliveryResult, DigestRepository, NotificationChannel } from './ports.js';

export const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_ERROR_LENGTH = 500;

export interface DigestOutcome {
  readonly channel: string;
  readonly status: DeliveryResult['status'];
}

/** Espera antes da próxima tentativa: 5, 20, 45 e 80 minutos. */
export function retryDelayMinutes(attempts: number): number | null {
  return attempts >= MAX_DELIVERY_ATTEMPTS ? null : 5 * attempts * attempts;
}

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : 'Falha desconhecida no envio.';
  return message.replace(/\s+/g, ' ').slice(0, MAX_ERROR_LENGTH);
}

/**
 * Envia, uma vez por dia e por canal, o resumo dos alertas ativos da loja a partir da hora
 * configurada. O envio é "pelo menos uma vez": se o processo cair entre o aceite do provedor e
 * o registro, a próxima tentativa pode repetir a mensagem.
 */
export class AlertDigestService {
  constructor(
    private readonly repository: DigestRepository,
    private readonly channels: readonly NotificationChannel[],
  ) {}

  /** Canais disponíveis no servidor (ex.: SMTP configurado). */
  get channelIds(): readonly string[] {
    return this.channels.map((channel) => channel.id);
  }

  async runDue(storeId: string): Promise<DigestOutcome[]> {
    const schedule = await this.repository.schedule(storeId);
    if (!schedule || schedule.localHour < schedule.digestHour) return [];
    const outcomes: DigestOutcome[] = [];
    for (const channel of this.channels) {
      const recipients = schedule.recipients[channel.id] ?? [];
      if (recipients.length === 0) continue;
      const claim = await this.repository.claim(
        storeId,
        channel.id,
        schedule.localDate,
        recipients,
      );
      if (!claim) continue;
      const { alerts, sections } = await this.repository.activeAlerts(storeId);
      const message = buildAlertDigest({
        storeName: schedule.storeName,
        localDate: schedule.localDate,
        alerts,
        sections,
        salesDelayedThrough: schedule.salesDelayedThrough ?? null,
      });
      let result: DeliveryResult;
      if (!message) {
        result = { status: 'SKIPPED' };
      } else {
        try {
          const receipt = await channel.send(recipients, message, {
            storeId,
            storeName: schedule.storeName,
          });
          result = {
            status: 'SENT',
            alertCount: message.alertCount,
            providerMessageId: receipt.providerMessageId,
          };
        } catch (error) {
          result = {
            status: 'FAILED',
            alertCount: message.alertCount,
            error: describeError(error),
            retryInMinutes: retryDelayMinutes(claim.attempts),
          };
        }
      }
      await this.repository.finish(storeId, claim, result);
      outcomes.push({ channel: channel.id, status: result.status });
    }
    return outcomes;
  }

  /** Envia uma mensagem de teste para os destinatários configurados de cada canal. */
  async sendTest(storeId: string): Promise<{ channel: string; recipients: number }[]> {
    const schedule = await this.repository.schedule(storeId);
    if (!schedule) return [];
    const message = buildTestMessage(schedule.storeName);
    const sent: { channel: string; recipients: number }[] = [];
    for (const channel of this.channels) {
      const recipients = schedule.recipients[channel.id] ?? [];
      if (recipients.length === 0) continue;
      await channel.send(recipients, message, { storeId, storeName: schedule.storeName });
      sent.push({ channel: channel.id, recipients: recipients.length });
    }
    return sent;
  }
}
