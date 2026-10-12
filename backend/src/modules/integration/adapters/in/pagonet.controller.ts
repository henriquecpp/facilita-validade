import { Body, Controller, Get, Headers, Inject, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { AuthGuard, CurrentActor } from '../../../identity/adapters/in/auth.guard.js';
import type { TenantActor } from '../../../../shared/domain/context.js';
import { PagonetSourceDto } from '../../../inventory/adapters/in/dtos.js';
import { PagonetSync } from '../out/pagonet-sync.js';

/** Configuração e situação da importação pela Pagonet (Facilita Validade). Só o proprietário. */
@Controller('pagonet-source')
@ApiTags('Administração de integração')
@ApiBearerAuth()
@UseGuards(AuthGuard)
export class PagonetController {
  constructor(@Inject(PagonetSync) readonly sync: PagonetSync) {}
  @Get() view(@CurrentActor() a: TenantActor) {
    return this.sync.view(a);
  }
  @Post() configure(
    @CurrentActor() a: TenantActor,
    @Headers('idempotency-key') key: string,
    @Body() input: PagonetSourceDto,
  ) {
    return this.sync.configure(a, key, input);
  }
  @Post('sync') request(@CurrentActor() a: TenantActor, @Headers('idempotency-key') key: string) {
    return this.sync.requestSync(a, key);
  }
}
