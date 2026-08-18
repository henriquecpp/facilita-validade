import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import type { TenantActor } from '../../../../shared/domain/context.js';
import {
  AttemptLimiter,
  credentialKey,
  requireSameOrigin,
  sessionCookie,
  type CookieReply,
} from '../../../../shared/infrastructure/web-security.js';
import { AuthService, type SessionResult } from '../../application/auth-service.js';
import { PairingService } from '../../application/pairing-service.js';
import {
  AllowRestrictedSession,
  AuthGuard,
  CurrentActor,
  bearer,
  type IdentityRequest,
} from './auth.guard.js';
import {
  ChangePasswordDto,
  CompletePasswordResetDto,
  LoginDto,
  LogoutDto,
  RedeemPairingDto,
  RefreshDto,
} from './identity.dto.js';

@ApiTags('Identity')
@Controller()
export class AuthController {
  private readonly limiter = new AttemptLimiter();
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(PairingService) private readonly pairings: PairingService,
  ) {}
  private cookie() {
    return sessionCookie('estoque_refresh');
  }
  private csrf(request: IdentityRequest) {
    requireSameOrigin(request);
  }
  private limit(request: IdentityRequest, credentials?: LoginDto) {
    const keys: [string, number][] = [[`ip:${request.ip ?? 'unknown'}`, 30]];
    if (credentials)
      keys.push([
        credentialKey(
          `${credentials.cnpj.replace(/[./\-\s]/g, '').toUpperCase()}:${credentials.username.trim().toLowerCase()}`,
        ),
        10,
      ]);
    this.limiter.hit(keys);
  }
  private webResult(result: SessionResult, reply: CookieReply) {
    const cookie = this.cookie();
    reply.header('Cache-Control', 'no-store');
    if (result.refreshToken)
      reply.setCookie(cookie.name, result.refreshToken, { ...cookie.options, maxAge: 30 * 86400 });
    else reply.clearCookie(cookie.name, cookie.options);
    const { refreshToken: _secret, ...publicResult } = result;
    return publicResult;
  }
  @Post('auth/web/login')
  @HttpCode(200)
  async loginWeb(
    @Body() input: LoginDto,
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) reply: CookieReply,
  ) {
    this.csrf(request);
    this.limit(request, input);
    return this.webResult(await this.auth.login(input, 'web'), reply);
  }
  @Post('auth/mobile/login')
  @HttpCode(200)
  async loginMobile(
    @Body() input: LoginDto,
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) reply: CookieReply,
  ) {
    this.limit(request, input);
    reply.header('Cache-Control', 'no-store');
    return this.auth.login(input, 'mobile');
  }
  /** Coletor troca o código lido do QR por uma sessão. Só mobile: o painel é quem mostra o QR. */
  @Post('auth/mobile/pair')
  @HttpCode(200)
  async pairMobile(
    @Body() input: RedeemPairingDto,
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) reply: CookieReply,
  ) {
    this.limit(request);
    reply.header('Cache-Control', 'no-store');
    return this.pairings.redeem(input.code);
  }
  @Post('auth/web/refresh')
  @HttpCode(200)
  async refreshWeb(
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) reply: CookieReply,
  ) {
    this.csrf(request);
    this.limit(request);
    return this.webResult(
      await this.auth.refresh(request.cookies?.[this.cookie().name] ?? '', 'web'),
      reply,
    );
  }
  @Post('auth/mobile/refresh')
  @HttpCode(200)
  async refreshMobile(
    @Body() input: RefreshDto,
    @Req() request: IdentityRequest,
    @Res({ passthrough: true }) reply: CookieReply,
  ) {
    this.limit(request);
    reply.header('Cache-Control', 'no-store');
    return this.auth.refresh(input.refreshToken, 'mobile');
  }
  @Post('auth/web/logout')
  @HttpCode(200)
  async logoutWeb(@Req() request: IdentityRequest, @Res({ passthrough: true }) reply: CookieReply) {
    this.csrf(request);
    const cookie = this.cookie();
    const result = await this.auth.logout(request.cookies?.[cookie.name], bearer(request), 'web');
    reply.clearCookie(cookie.name, cookie.options);
    reply.header('Cache-Control', 'no-store');
    return result;
  }
  @Post('auth/mobile/logout')
  @HttpCode(200)
  logoutMobile(@Body() input: LogoutDto, @Req() request: IdentityRequest) {
    return this.auth.logout(input?.refreshToken, bearer(request), 'mobile');
  }
  @Get('me')
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @AllowRestrictedSession()
  me(@CurrentActor() actor: TenantActor) {
    return this.auth.me(actor);
  }
  @Post('auth/change-password')
  @HttpCode(200)
  @ApiBearerAuth()
  @UseGuards(AuthGuard)
  @AllowRestrictedSession()
  changePassword(@CurrentActor() actor: TenantActor, @Body() input: ChangePasswordDto) {
    return this.auth.changePassword(actor, input.currentPassword, input.newPassword);
  }
  @Post('auth/complete-password-reset')
  @HttpCode(200)
  completeReset(@Body() input: CompletePasswordResetDto, @Req() request: IdentityRequest) {
    this.limit(request);
    return this.auth.completePasswordReset(input.token, input.newPassword);
  }
}
