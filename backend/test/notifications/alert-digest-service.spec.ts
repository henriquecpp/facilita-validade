import { describe, expect, it } from 'vitest';
import {
  AlertDigestService,
  MAX_DELIVERY_ATTEMPTS,
  retryDelayMinutes,
} from '../../src/modules/notifications/application/alert-digest-service.js';
import type {
  DeliveryClaim,
  DeliveryResult,
  DigestRepository,
  DigestSchedule,
  NotificationChannel,
  OutboundMessage,
} from '../../src/modules/notifications/application/ports.js';
import type { DigestAlert } from '../../src/modules/notifications/domain/digest.js';
import { smtpConfigFromEnv } from '../../src/modules/notifications/adapters/out/smtp-email-channel.js';

class FakeRepository implements DigestRepository {
  claims: DeliveryClaim[] = [{ id: 'delivery-1', attempts: 1 }];
  finished: DeliveryResult[] = [];
  constructor(
    public scheduleValue: DigestSchedule | null,
    public alerts: DigestAlert[] = [],
  ) {}
  async schedule() {
    return this.scheduleValue;
  }
  async claim() {
    return this.claims.shift() ?? null;
  }
  async activeAlerts() {
    return {
      alerts: this.alerts,
      sections: [{ key: 'urgente', title: 'Urgente', expired: false }],
    };
  }
  async finish(_storeId: string, _claim: DeliveryClaim, result: DeliveryResult) {
    this.finished.push(result);
  }
}

class FakeChannel implements NotificationChannel {
  readonly id = 'email';
  sent: { recipients: readonly string[]; message: OutboundMessage }[] = [];
  constructor(private readonly failure?: Error) {}
  async send(recipients: readonly string[], message: OutboundMessage) {
    if (this.failure) throw this.failure;
    this.sent.push({ recipients, message });
    return { providerMessageId: '<id@test>' };
  }
}

const schedule = (overrides: Partial<DigestSchedule> = {}): DigestSchedule => ({
  storeName: 'Loja Centro',
  localDate: '2026-09-28',
  localHour: 7,
  digestHour: 7,
  recipients: { email: ['gerente@loja.com'] },
  ...overrides,
});
const alert: DigestAlert = {
  productName: 'Iogurte',
  expiresOn: '2026-09-30',
  quantity: 3,
  lotCode: null,
  section: 'urgente',
};

describe('Envio do resumo diário', () => {
  it('não envia antes da hora configurada no fuso da loja', async () => {
    const repository = new FakeRepository(schedule({ localHour: 6 }), [alert]);
    const channel = new FakeChannel();
    expect(await new AlertDigestService(repository, [channel]).runDue('store')).toEqual([]);
    expect(channel.sent).toEqual([]);
  });

  it('envia uma vez e registra o identificador do provedor', async () => {
    const repository = new FakeRepository(schedule(), [alert]);
    const channel = new FakeChannel();
    const service = new AlertDigestService(repository, [channel]);
    expect(await service.runDue('store')).toEqual([{ channel: 'email', status: 'SENT' }]);
    expect(channel.sent[0]?.recipients).toEqual(['gerente@loja.com']);
    expect(repository.finished).toEqual([
      { status: 'SENT', alertCount: 1, providerMessageId: '<id@test>' },
    ]);
    // Reserva já consumida no mesmo dia: nada é reenviado.
    expect(await service.runDue('store')).toEqual([]);
    expect(channel.sent).toHaveLength(1);
  });

  it('dispensa o dia sem alertas, sem enviar mensagem vazia', async () => {
    const repository = new FakeRepository(schedule(), []);
    const channel = new FakeChannel();
    await new AlertDigestService(repository, [channel]).runDue('store');
    expect(channel.sent).toEqual([]);
    expect(repository.finished).toEqual([{ status: 'SKIPPED' }]);
  });

  it('ignora canal sem destinatários', async () => {
    const repository = new FakeRepository(schedule({ recipients: { email: [] } }), [alert]);
    expect(await new AlertDigestService(repository, [new FakeChannel()]).runDue('store')).toEqual(
      [],
    );
    expect(repository.claims).toHaveLength(1);
  });

  it('registra falha com nova tentativa e encerra após o limite', async () => {
    const repository = new FakeRepository(schedule(), [alert]);
    const failing = new FakeChannel(new Error('535 Username and Password not accepted'));
    await new AlertDigestService(repository, [failing]).runDue('store');
    expect(repository.finished[0]).toMatchObject({
      status: 'FAILED',
      error: '535 Username and Password not accepted',
      retryInMinutes: 5,
    });
    repository.claims = [{ id: 'delivery-1', attempts: MAX_DELIVERY_ATTEMPTS }];
    await new AlertDigestService(repository, [failing]).runDue('store');
    expect(repository.finished[1]).toMatchObject({ status: 'FAILED', retryInMinutes: null });
    expect([1, 2, 3, 4].map(retryDelayMinutes)).toEqual([5, 20, 45, 80]);
  });
});

describe('Configuração SMTP', () => {
  it('fica desligada sem host e usa TLS implícito na porta 465 do Gmail', () => {
    expect(smtpConfigFromEnv({})).toBeNull();
    expect(
      smtpConfigFromEnv({
        SMTP_HOST: 'smtp.gmail.com',
        SMTP_USER: 'loja@gmail.com',
        SMTP_PASSWORD: 'senha-de-app',
      }),
    ).toEqual({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      user: 'loja@gmail.com',
      password: 'senha-de-app',
      from: 'loja@gmail.com',
    });
  });

  it('rejeita configuração incompleta ou inválida', () => {
    expect(() => smtpConfigFromEnv({ SMTP_HOST: 'smtp', SMTP_USER: 'a@b.c' })).toThrow(
      /SMTP_USER e SMTP_PASSWORD/,
    );
    expect(() => smtpConfigFromEnv({ SMTP_HOST: 'smtp', SMTP_PORT: 'x' })).toThrow(/SMTP_PORT/);
    expect(() => smtpConfigFromEnv({ SMTP_HOST: 'smtp' })).toThrow(/SMTP_FROM/);
  });
});
