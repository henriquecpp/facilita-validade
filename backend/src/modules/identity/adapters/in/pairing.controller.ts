import { Body, Controller, Header, HttpCode, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { TenantActor } from '../../../../shared/domain/context.js';
import { PairingService } from '../../application/pairing-service.js';
import { AuthGuard, CurrentActor } from './auth.guard.js';
import { IssuePairingDto } from './identity.dto.js';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('device-pairings')
export class PairingController {
  constructor(@Inject(PairingService) private readonly pairings: PairingService) {}

  /**
   * Código de uso único para o painel mostrar em QR. Sem Idempotency-Key: cada
   * chamada é uma credencial nova, e a resposta traz segredo — não pode ir para
   * command_receipts.
   */
  @Post()
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  issue(@CurrentActor() actor: TenantActor, @Body() input: IssuePairingDto) {
    return this.pairings.issue(actor, input.userId);
  }
}
