import 'reflect-metadata';
import {
  Controller,
  Get,
  Inject,
  Module,
  ValidationPipe,
  ServiceUnavailableException,
  Catch,
  HttpException,
  type ExceptionFilter,
  type ArgumentsHost,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { Database } from '../shared/infrastructure/database.js';
import { Jobs } from '../shared/infrastructure/jobs.js';
import { sqlState } from '../shared/infrastructure/database-errors.js';
import { ApplicationError } from '../shared/domain/context.js';
import { InventoryDomainError } from '../modules/inventory/domain/index.js';
import { ErpReportError } from '../modules/integration/domain/erp-report.js';
import { InventoryService } from '../modules/inventory/application/inventory-service.js';
import { PrismaInventory } from '../modules/inventory/adapters/out/prisma-inventory.js';
import { PrismaCatalog } from '../modules/catalog/adapters/out/prisma-catalog.js';
import { PrismaStore } from '../modules/tenancy/adapters/out/prisma-store.js';
import { PrismaIntegration } from '../modules/integration/adapters/out/prisma-integration.js';
import { PrismaImports } from '../modules/integration/adapters/out/prisma-imports.js';
import { PagonetSync } from '../modules/integration/adapters/out/pagonet-sync.js';
import { PagonetController } from '../modules/integration/adapters/in/pagonet.controller.js';
import { PrismaNotifications } from '../modules/notifications/adapters/out/prisma-notifications.js';
import { AlertDigestService } from '../modules/notifications/application/alert-digest-service.js';
import type { NotificationChannel } from '../modules/notifications/application/ports.js';
import { createAlertDigestService, createPush } from '../modules/notifications/composition.js';
import { PrismaPush } from '../modules/notifications/adapters/out/prisma-push.js';
import { PushController } from '../modules/notifications/adapters/in/push.controller.js';
import { InventoryController } from '../modules/inventory/adapters/in/inventory.controller.js';
import {
  IntegrationController,
  IntegrationAdminController,
} from '../modules/integration/adapters/in/integration.controller.js';
import { StoreController } from '../modules/tenancy/adapters/in/store.controller.js';
import { createIdentityServices } from '../modules/identity/composition.js';
import { PairingService } from '../modules/identity/application/pairing-service.js';
import { PairingController } from '../modules/identity/adapters/in/pairing.controller.js';
import { PrismaDatabase } from '../shared/infrastructure/prisma.js';
import { AuthService } from '../modules/identity/application/auth-service.js';
import { AuthController } from '../modules/identity/adapters/in/auth.controller.js';
import { UsersController } from '../modules/identity/adapters/in/users.controller.js';
import { DeviceSessionsController } from '../modules/identity/adapters/in/device-sessions.controller.js';
import { AuthGuard } from '../modules/identity/adapters/in/auth.guard.js';
import { createPlatformService } from '../modules/platform/composition.js';
import { PlatformService } from '../modules/platform/application/platform-service.js';
import { PlatformGuard } from '../modules/platform/adapters/in/platform.guard.js';
import {
  PlatformAuthController,
  PlatformStoresController,
} from '../modules/platform/adapters/in/platform.controller.js';
@Controller('health')
class HealthController {
  constructor(@Inject(Database) readonly db: Database) {}
  @Get('live') live() {
    return { status: 'ok' };
  }
  @Get('ready') async ready() {
    try {
      await this.db.pool.query('SELECT 1');
      return { status: 'ok' };
    } catch {
      throw new ServiceUnavailableException('Dependência indisponível.');
    }
  }
}
/** Erro 4xx com `statusCode`, como os que o Fastify e seus plugins lançam. */
function clientError(error: unknown): error is { statusCode: number; message: string } {
  const status = (error as { statusCode?: unknown } | null)?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500;
}

@Catch()
class ApiErrors implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest<FastifyRequest>();
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    let status = 500,
      code = 'INTERNAL_ERROR',
      message = 'Não foi possível concluir a operação.';
    let fieldErrors: unknown;
    if (error instanceof ApplicationError) {
      status = error.status;
      code = error.code;
      message = error.message;
    } else if (error instanceof InventoryDomainError || error instanceof ErpReportError) {
      status = 422;
      code = error.code;
      message = error.message;
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      code = status === 400 ? 'INVALID_REQUEST' : `HTTP_${status}`;
      const payload = error.getResponse();
      if (typeof payload === 'object' && payload && 'message' in payload) {
        fieldErrors = Array.isArray(payload.message) ? payload.message : undefined;
        message = Array.isArray(payload.message)
          ? 'Confira os campos informados.'
          : String(payload.message);
      } else message = String(payload);
    } else if (clientError(error)) {
      // Erros do próprio Fastify, como o limite de requisições (429) e o corpo grande demais
      // (413): a requisição foi recusada antes de qualquer efeito. Como 500, o coletor os
      // trataria como envio sem confirmação e travaria o lançamento à espera de reenvio.
      status = error.statusCode;
      code = status === 429 ? 'RATE_LIMITED' : `HTTP_${status}`;
      message =
        status === 429
          ? 'Muitas requisições em pouco tempo. Aguarde um instante e tente de novo.'
          : error.message;
    } else {
      const state = sqlState(error);
      if (state === '23505' || state === '23503') {
        status = 409;
        code = 'DATA_CONFLICT';
        message = 'A operação conflita com dados existentes.';
      } else if (state === '55P03' || state === '57014' || state === '40P01') {
        status = 503;
        code = 'INVENTORY_BUSY';
        message = 'Estoque ocupado. Repita com a mesma chave.';
      } else if (state === '22P02' || state === '22008') {
        status = 400;
        code = 'INVALID_REQUEST';
        message = 'Identificador ou data inválidos.';
      }
    }
    if (status === 500) request.log.error({ err: error, requestId: request.id }, 'request_failed');
    reply
      .status(status)
      .send({ code, message, ...(fieldErrors ? { fieldErrors } : {}), requestId: request.id });
  }
}
export interface AppOptions {
  database?: Database;
  prisma?: PrismaDatabase;
  jobs?: Jobs;
  jwtSecret?: string;
  logging?: boolean;
  /** Substitui os canais lidos do ambiente (testes). */
  notificationChannels?: readonly NotificationChannel[];
  /** Monta a importação da Pagonet com cliente e chave próprios (testes). */
  pagonet?: (prisma: PrismaDatabase, jobs: Jobs, integration: PrismaIntegration) => PagonetSync;
  /** Substitui o push lido do ambiente (testes). */
  push?: (prisma: PrismaDatabase) => PrismaPush;
}
export async function createApp(options: AppOptions = {}) {
  const database = options.database ?? new Database();
  const prisma = options.prisma ?? new PrismaDatabase(database);
  const jobs = options.jobs ?? new Jobs();
  const jwtSecret = options.jwtSecret ?? process.env.JWT_SECRET;
  if (!jwtSecret || jwtSecret.length < 32)
    throw new Error('JWT_SECRET deve conter no mínimo 32 caracteres.');
  const proxyHops = Number(process.env.TRUST_PROXY_HOPS ?? 0);
  if (!Number.isInteger(proxyHops) || proxyHops < 0 || proxyHops > 1)
    throw new Error('TRUST_PROXY_HOPS deve ser 0 ou 1.');
  const identity = createIdentityServices(prisma, jwtSecret);
  const inventory = new PrismaInventory(prisma, jobs);
  const integration = new PrismaIntegration(prisma, jobs, inventory);
  const notifications = new PrismaNotifications(prisma);
  const push = options.push?.(prisma) ?? createPush(prisma);
  const digests = createAlertDigestService(prisma, options.notificationChannels, push);
  const pagonet =
    options.pagonet?.(prisma, jobs, integration) ?? new PagonetSync(prisma, jobs, integration);
  const platform = createPlatformService(prisma, identity.crypto, pagonet);
  @Module({
    controllers: [
      HealthController,
      AuthController,
      UsersController,
      PairingController,
      DeviceSessionsController,
      InventoryController,
      IntegrationController,
      IntegrationAdminController,
      PagonetController,
      StoreController,
      PushController,
      PlatformAuthController,
      PlatformStoresController,
    ],
    providers: [
      AuthGuard,
      PlatformGuard,
      { provide: PlatformService, useValue: platform },
      { provide: Database, useValue: database },
      { provide: Jobs, useValue: jobs },
      { provide: AuthService, useValue: identity.auth },
      { provide: PairingService, useValue: identity.pairing },
      { provide: PrismaInventory, useValue: inventory },
      { provide: InventoryService, useValue: new InventoryService(inventory) },
      { provide: PrismaCatalog, useValue: new PrismaCatalog(prisma) },
      { provide: PrismaStore, useValue: new PrismaStore(prisma, jobs, digests.channelIds) },
      { provide: AlertDigestService, useValue: digests },
      { provide: PrismaIntegration, useValue: integration },
      { provide: PrismaImports, useValue: new PrismaImports(prisma, jobs) },
      { provide: PagonetSync, useValue: pagonet },
      { provide: PrismaNotifications, useValue: notifications },
      { provide: PrismaPush, useValue: push },
    ],
  })
  class AppModule {}
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({
      bodyLimit: 2 * 1024 * 1024,
      trustProxy: proxyHops === 0 ? false : (_address: string, hop: number) => hop < proxyHops,
      logger: options.logging ?? false,
      requestTimeout: 20000,
    }),
    { logger: options.logging ? ['error', 'warn', 'log'] : false },
  );
  await app.register(cookie);
  await app.register(helmet);
  await app.register(rateLimit, {
    // Na loja, coletores e painel saem pelo mesmo IP e somam no mesmo limite. Com token a
    // folga é maior, para dois coletores lendo rápido não se barrarem; sem token — login,
    // renovação, chamada anônima — o limite segue o de antes, numa conta separada que o
    // movimento da loja não esgota.
    keyGenerator: (request) =>
      `${request.ip}:${request.headers.authorization?.startsWith('Bearer ') ? 'token' : 'anon'}`,
    max: (_request, key) => (key.endsWith(':token') ? 1200 : 300),
    timeWindow: '1 minute',
  });
  app.setGlobalPrefix('api/v1');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.useGlobalFilters(new ApiErrors());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return {
    app,
    database,
    prisma,
    jobs,
    inventory,
    integration,
    notifications,
    digests,
    pagonet,
    push,
  };
}
