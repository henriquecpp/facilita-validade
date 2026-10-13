import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { TenantActor } from '../../../../shared/domain/context.js';
import { AuthService } from '../../application/auth-service.js';
import { AuthGuard, CurrentActor } from './auth.guard.js';

/** Coletores conectados à loja, que o proprietário vê e desconecta pelo painel. */
@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('device-sessions')
export class DeviceSessionsController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}

  @Get() list(@CurrentActor() actor: TenantActor) {
    return this.auth.deviceSessions(actor);
  }

  /** Sem Idempotency-Key: desconectar de novo não muda nada. */
  @Post(':id/revoke')
  @HttpCode(200)
  revoke(@CurrentActor() actor: TenantActor, @Param('id', ParseUUIDPipe) id: string) {
    return this.auth.revokeDeviceSession(actor, id);
  }
}
