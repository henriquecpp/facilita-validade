import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Headers,
  Body,
  Param,
  Inject,
  UseGuards,
  Query,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { AuthGuard, CurrentActor } from '../../../identity/adapters/in/auth.guard.js';
import { PrismaStore } from '../out/prisma-store.js';
import { PrismaNotifications } from '../../../notifications/adapters/out/prisma-notifications.js';
import { AlertDigestService } from '../../../notifications/application/alert-digest-service.js';
import {
  ApplicationError,
  requireRole,
  type TenantActor,
} from '../../../../shared/domain/context.js';
import {
  SettingsDto,
  ListQueryDto,
  ExpiryLevelsDto,
  NotificationQueryDto,
} from '../../../inventory/adapters/in/dtos.js';
@Controller()
@ApiTags('Loja e operação')
@ApiBearerAuth()
@UseGuards(AuthGuard)
export class StoreController {
  constructor(
    @Inject(PrismaStore) readonly store: PrismaStore,
    @Inject(PrismaNotifications) readonly notifications: PrismaNotifications,
    @Inject(AlertDigestService) readonly digests: AlertDigestService,
  ) {}
  @Get('store') info(@CurrentActor() a: TenantActor) {
    return this.store.store(a.storeId);
  }
  @Get('store/settings') settings(@CurrentActor() a: TenantActor) {
    return this.store.settings(a.storeId);
  }
  @Patch('store/settings') update(
    @CurrentActor() a: TenantActor,
    @Headers('idempotency-key') key: string,
    @Body() input: SettingsDto,
  ) {
    return this.store.update(a, key, input);
  }
  /** Níveis de urgência da loja, do mais urgente ao mais tranquilo. */
  @Get('store/expiry-levels') levels(@CurrentActor() a: TenantActor) {
    return this.store.levels(a.storeId);
  }
  /** Troca a lista inteira de níveis; só o proprietário. Faixas sobrepostas são recusadas. */
  @Put('store/expiry-levels') updateLevels(
    @CurrentActor() a: TenantActor,
    @Headers('idempotency-key') key: string,
    @Body() input: ExpiryLevelsDto,
  ) {
    return this.store.updateLevels(a, key, input);
  }
  /** Envia uma mensagem de teste aos destinatários salvos, para validar o SMTP (ex.: Gmail). */
  @Post('store/settings/test-email') async testEmail(@CurrentActor() a: TenantActor) {
    requireRole(a, ['OWNER']);
    if (!this.digests.channelIds.includes('email'))
      throw new ApplicationError(
        'EMAIL_NOT_CONFIGURED',
        'O servidor não tem SMTP configurado para enviar e-mails.',
        503,
      );
    let sent: Awaited<ReturnType<AlertDigestService['sendTest']>>;
    try {
      sent = await this.digests.sendTest(a.storeId);
    } catch (error) {
      const detail = error instanceof Error ? error.message.replace(/\s+/g, ' ').slice(0, 300) : '';
      throw new ApplicationError('DELIVERY_FAILED', `Não foi possível enviar: ${detail}`, 502);
    }
    const email = sent.find((item) => item.channel === 'email');
    if (!email)
      throw new ApplicationError('NO_RECIPIENTS', 'Cadastre ao menos um e-mail e salve.', 422);
    return { recipients: email.recipients };
  }
  @Get('dashboard/summary') dashboard(@CurrentActor() a: TenantActor) {
    return this.store.dashboard(a);
  }
  @Get('notifications') alerts(
    @CurrentActor() a: TenantActor,
    @Query() options: NotificationQueryDto,
  ) {
    return this.notifications.list(a.storeId, a.userId, options);
  }
  @Post('notifications/:id/read') read(
    @CurrentActor() a: TenantActor,
    @Headers('idempotency-key') key: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.notifications.read(a, key, id);
  }
  @Get('operations/:key') operation(
    @CurrentActor() a: TenantActor,
    @Param('key', ParseUUIDPipe) key: string,
    @Query('operation') operation: string,
  ) {
    return this.store.operation(a, key, operation);
  }
  @Get('audit-events') audit(@CurrentActor() a: TenantActor, @Query() options: ListQueryDto) {
    return this.store.auditEvents(a, options);
  }
}
