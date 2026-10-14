import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import {
  AttemptLimiter,
  credentialKey,
  requireSameOrigin,
  type CookieReply,
} from '../../../../shared/infrastructure/web-security.js';
import { PlatformService } from '../../application/platform-service.js';
import { PLATFORM_SESSION_SECONDS, type PlatformActor } from '../../domain/platform.js';
import {
  CreateStoreDto,
  HistoryQueryDto,
  OwnerAccessDto,
  PlatformLoginDto,
  PlatformPasswordDto,
  ReasonDto,
} from './platform.dto.js';
import {
  AllowPendingPassword,
  CurrentPlatformAdmin,
  PlatformGuard,
  platformCookie,
  type PlatformRequest,
} from './platform.guard.js';

/** Entrar e sair do painel da plataforma, quem está e troca de senha. */
@ApiTags('Plataforma')
@Controller('platform')
export class PlatformAuthController {
  private readonly limiter = new AttemptLimiter();
  constructor(@Inject(PlatformService) private readonly platform: PlatformService) {}

  @Post('auth/login')
  @HttpCode(200)
  async login(
    @Body() input: PlatformLoginDto,
    @Req() request: PlatformRequest,
    @Res({ passthrough: true }) reply: CookieReply,
  ) {
    requireSameOrigin(request);
    // Mais apertado que o login das lojas: poucas pessoas entram aqui, e o alcance é maior.
    this.limiter.hit([
      [`ip:${request.ip ?? 'unknown'}`, 20],
      [credentialKey(`platform:${input.username.trim().toLowerCase()}`), 5],
    ]);
    const session = await this.platform.login(input.username, input.password);
    const cookie = platformCookie();
    reply.header('Cache-Control', 'no-store');
    reply.setCookie(cookie.name, session.token, {
      ...cookie.options,
      maxAge: PLATFORM_SESSION_SECONDS,
    });
    return session.admin;
  }

  @Post('auth/logout')
  @HttpCode(200)
  async logout(@Req() request: PlatformRequest, @Res({ passthrough: true }) reply: CookieReply) {
    requireSameOrigin(request);
    const cookie = platformCookie();
    const result = await this.platform.logout(request.cookies?.[cookie.name]);
    reply.clearCookie(cookie.name, cookie.options);
    reply.header('Cache-Control', 'no-store');
    return result;
  }

  @Get('me')
  @ApiCookieAuth()
  @UseGuards(PlatformGuard)
  @AllowPendingPassword()
  me(@CurrentPlatformAdmin() actor: PlatformActor) {
    return this.platform.me(actor);
  }

  @Post('auth/change-password')
  @HttpCode(200)
  @ApiCookieAuth()
  @UseGuards(PlatformGuard)
  @AllowPendingPassword()
  changePassword(@CurrentPlatformAdmin() actor: PlatformActor, @Body() input: PlatformPasswordDto) {
    return this.platform.changePassword(actor, input.currentPassword, input.newPassword);
  }
}

/** Lojas, histórico e integração vistos pela plataforma. */
@ApiTags('Plataforma')
@ApiCookieAuth()
@Controller('platform')
@UseGuards(PlatformGuard)
export class PlatformStoresController {
  constructor(@Inject(PlatformService) private readonly platform: PlatformService) {}

  @Get('stores') stores() {
    return this.platform.stores();
  }

  /** A resposta traz a senha provisória do proprietário, uma vez só. */
  @Post('stores')
  @HttpCode(201)
  @Header('Cache-Control', 'no-store')
  create(@CurrentPlatformAdmin() actor: PlatformActor, @Body() input: CreateStoreDto) {
    return this.platform.createStore(actor, input);
  }

  @Get('stores/:id') store(@Param('id', ParseUUIDPipe) id: string) {
    return this.platform.store(id);
  }

  @Post('stores/:id/suspend')
  @HttpCode(200)
  suspend(
    @CurrentPlatformAdmin() actor: PlatformActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: ReasonDto,
  ) {
    return this.platform.suspend(actor, id, input.reason);
  }

  @Post('stores/:id/reactivate')
  @HttpCode(200)
  reactivate(
    @CurrentPlatformAdmin() actor: PlatformActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: ReasonDto,
  ) {
    return this.platform.reactivate(actor, id, input.reason);
  }

  /** A resposta traz o link de uso único, uma vez só. */
  @Post('stores/:id/owner-access')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  ownerAccess(
    @CurrentPlatformAdmin() actor: PlatformActor,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() input: OwnerAccessDto,
  ) {
    return this.platform.ownerAccess(actor, id, input.userId, input.reason);
  }

  @Get('history') history(@Query() query: HistoryQueryDto) {
    return this.platform.history(query.cursor, query.limit);
  }

  @Get('pagonet') pagonet() {
    return this.platform.pagonetStatus();
  }

  @Post('pagonet/check')
  @HttpCode(200)
  checkPagonet() {
    return this.platform.checkPagonet();
  }
}
