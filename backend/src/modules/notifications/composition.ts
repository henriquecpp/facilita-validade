import type { PrismaDatabase } from '../../shared/infrastructure/prisma.js';
import { AlertDigestService } from './application/alert-digest-service.js';
import type { NotificationChannel } from './application/ports.js';
import { PrismaDigests } from './adapters/out/prisma-digests.js';
import { SmtpEmailChannel, smtpConfigFromEnv } from './adapters/out/smtp-email-channel.js';
import { PrismaPush, PushChannel } from './adapters/out/prisma-push.js';
import { vapidFromEnv, WebPushSender } from './adapters/out/web-push.js';
import { fcmFromEnv, FcmSender } from './adapters/out/fcm.js';

/** Push do servidor: Web Push (VAPID) para o painel e Firebase para o coletor, se configurados. */
export function createPush(
  prisma: PrismaDatabase,
  env: NodeJS.ProcessEnv = process.env,
): PrismaPush {
  const vapid = vapidFromEnv(env);
  const fcm = fcmFromEnv(env);
  return new PrismaPush(
    prisma,
    vapid ? new WebPushSender(vapid) : null,
    fcm ? new FcmSender(fcm) : null,
  );
}

/**
 * Canais habilitados pela configuração do servidor. Para um novo provedor (ex.: WhatsApp),
 * implemente `NotificationChannel`, registre-o aqui e informe seus destinatários no repositório.
 */
export function createNotificationChannels(
  env: NodeJS.ProcessEnv = process.env,
  push?: PrismaPush,
): NotificationChannel[] {
  const smtp = smtpConfigFromEnv(env);
  return [
    ...(smtp ? [new SmtpEmailChannel(smtp)] : []),
    ...(push?.available ? [new PushChannel(push)] : []),
  ];
}

export function createAlertDigestService(
  prisma: PrismaDatabase,
  channels?: readonly NotificationChannel[],
  push?: PrismaPush,
): AlertDigestService {
  return new AlertDigestService(
    new PrismaDigests(prisma, push),
    channels ?? createNotificationChannels(process.env, push),
  );
}
