import {
  createParamDecorator,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApplicationError } from '../../../../shared/domain/context.js';
import {
  requireSameOrigin,
  sessionCookie,
  type WebRequest,
} from '../../../../shared/infrastructure/web-security.js';
import { PlatformService } from '../../application/platform-service.js';
import type { PlatformActor } from '../../domain/platform.js';

export interface PlatformRequest extends WebRequest {
  method?: string;
  platform?: PlatformActor;
}

/** Cookie da sessão do painel da plataforma; o das lojas é outro. */
export const platformCookie = () => sessionCookie('estoque_platform');

/** Rotas que valem com a senha provisória ainda por trocar: ver quem está e trocar. */
export const AllowPendingPassword = () => SetMetadata('platform.allowPendingPassword', true);

/**
 * Sessão da plataforma, por cookie HttpOnly. Como o navegador manda o cookie sozinho, toda
 * escrita exige a origem do painel e o cabeçalho anti-CSRF. Token de loja não entra aqui.
 */
@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(
    @Inject(PlatformService) private readonly platform: PlatformService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<PlatformRequest>();
    if (!['GET', 'HEAD'].includes(request.method ?? 'GET')) requireSameOrigin(request);
    const actor = await this.platform.authenticate(request.cookies?.[platformCookie().name]);
    const pendingAllowed = this.reflector.getAllAndOverride<boolean>(
      'platform.allowPendingPassword',
      [context.getHandler(), context.getClass()],
    );
    if (actor.mustChangePassword && !pendingAllowed)
      throw new ApplicationError(
        'PASSWORD_CHANGE_REQUIRED',
        'Defina uma senha nova antes de continuar.',
        403,
      );
    request.platform = actor;
    return true;
  }
}

export const CurrentPlatformAdmin = createParamDecorator(
  (_data: unknown, context: ExecutionContext): PlatformActor => {
    const actor = context.switchToHttp().getRequest<PlatformRequest>().platform;
    if (!actor)
      throw new ApplicationError('UNAUTHORIZED', 'Contexto de autenticação ausente.', 401);
    return actor;
  },
);
