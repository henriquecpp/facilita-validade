import {
  createParamDecorator,
  ExecutionContext,
  Injectable,
  Inject,
  SetMetadata,
  type CanActivate,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ApplicationError, type TenantActor } from '../../../../shared/domain/context.js';
import { AuthService } from '../../application/auth-service.js';

export interface IdentityRequest {
  headers: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
  ip?: string;
  actor?: TenantActor;
}
export function bearer(request: IdentityRequest): string | undefined {
  const header = request.headers.authorization;
  return typeof header === 'string' && /^Bearer [^\s]+$/.test(header) ? header.slice(7) : undefined;
}
export const AllowRestrictedSession = () => SetMetadata('identity.allowRestricted', true);
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(Reflector) private readonly reflector: Reflector,
  ) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<IdentityRequest>();
    const token = bearer(request);
    if (!token)
      throw new ApplicationError('UNAUTHORIZED', 'Entre na sua conta para continuar.', 401);
    const actor = await this.auth.authenticate(token);
    const allowed = this.reflector.getAllAndOverride<boolean>('identity.allowRestricted', [
      context.getHandler(),
      context.getClass(),
    ]);
    if (actor.restricted && !allowed)
      throw new ApplicationError(
        'PASSWORD_CHANGE_REQUIRED',
        'Altere a senha provisória antes de continuar.',
        403,
      );
    request.actor = actor;
    return true;
  }
}
export const CurrentActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantActor => {
    const actor = context.switchToHttp().getRequest<IdentityRequest>().actor;
    if (!actor)
      throw new ApplicationError('UNAUTHORIZED', 'Contexto de autenticação ausente.', 401);
    return actor;
  },
);
