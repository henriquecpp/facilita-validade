import type { DigestAlert, DigestSection } from '../domain/digest.js';

export interface OutboundMessage {
  readonly subject: string;
  readonly text: string;
  readonly html: string;
  /** Linha curta com a contagem do resumo, para canais de texto curto como o push. */
  readonly summary?: string;
}

/** A loja do envio, para canais que buscam os destinatários sob a loja (push). */
export interface ChannelContext {
  readonly storeId: string;
  readonly storeName: string;
}

/**
 * Porta de saída de um canal de aviso. Hoje há e-mail (SMTP) e push; WhatsApp ou SMS entram
 * como novos adapters desta interface, registrados em `composition.ts`, sem mudar o caso de uso.
 */
export interface NotificationChannel {
  /** Identificador estável gravado nos envios e usado para achar os destinatários, ex.: `email`. */
  readonly id: string;
  send(
    recipients: readonly string[],
    message: OutboundMessage,
    context?: ChannelContext,
  ): Promise<{ providerMessageId?: string }>;
}

export interface DigestSchedule {
  readonly storeName: string;
  /** Data civil atual no fuso da loja, `YYYY-MM-DD`. */
  readonly localDate: string;
  /** Hora atual no fuso da loja, 0–23. */
  readonly localHour: number;
  readonly digestHour: number;
  /** Destinatários por canal (`NotificationChannel.id`). */
  readonly recipients: Readonly<Record<string, readonly string[]>>;
  /**
   * Vendas paradas na origem: a mais recente recebida, `AAAA-MM-DD HH:MM` no horário da
   * loja. Ausente quando estão em dia.
   */
  readonly salesDelayedThrough?: string | null;
}

export interface DeliveryClaim {
  readonly id: string;
  readonly attempts: number;
}

export type DeliveryResult =
  | { readonly status: 'SENT'; readonly alertCount: number; readonly providerMessageId?: string }
  | { readonly status: 'SKIPPED' }
  | {
      readonly status: 'FAILED';
      readonly alertCount: number;
      readonly error: string;
      /** null encerra as tentativas. */
      readonly retryInMinutes: number | null;
    };

export interface DigestRepository {
  schedule(storeId: string): Promise<DigestSchedule | null>;
  /**
   * Reserva o envio do dia para o canal. Retorna null se já foi enviado, dispensado, está em
   * andamento ou ainda aguarda a próxima tentativa. Seguro com vários workers.
   */
  claim(
    storeId: string,
    channelId: string,
    digestDate: string,
    recipients: readonly string[],
  ): Promise<DeliveryClaim | null>;
  /** Alertas ativos e os níveis da loja que avisam, na ordem do resumo. */
  activeAlerts(storeId: string): Promise<{ alerts: DigestAlert[]; sections: DigestSection[] }>;
  finish(storeId: string, claim: DeliveryClaim, result: DeliveryResult): Promise<void>;
}
