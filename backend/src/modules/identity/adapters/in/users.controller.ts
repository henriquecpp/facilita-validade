import {
  Body,
  Controller,
  Get,
  Header,
  Inject,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { TenantActor } from '../../../../shared/domain/context.js';
import { AuthService } from '../../application/auth-service.js';
import { AuthGuard, CurrentActor } from './auth.guard.js';
import { CreateUserDto, UpdateUserDto } from './identity.dto.js';

@ApiTags('Users')
@ApiBearerAuth()
@UseGuards(AuthGuard)
@Controller('users')
export class UsersController {
  constructor(@Inject(AuthService) private readonly auth: AuthService) {}
  @Get() list(@CurrentActor() actor: TenantActor) {
    return this.auth.users(actor);
  }
  @Post() create(@CurrentActor() actor: TenantActor, @Body() input: CreateUserDto) {
    return this.auth.createUser(actor, input);
  }
  @Patch(':id') update(
    @CurrentActor() actor: TenantActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: UpdateUserDto,
  ) {
    return this.auth.updateUser(actor, id, input);
  }
  @Post(':id/reset-password')
  @Header('Cache-Control', 'no-store')
  reset(@CurrentActor() actor: TenantActor, @Param('id', ParseUUIDPipe) id: string) {
    return this.auth.resetPassword(actor, id);
  }
}
