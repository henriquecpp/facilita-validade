export type Role = 'OWNER' | 'MANAGER' | 'OPERATOR';
export interface TenantActor {
  storeId: string;
  userId: string;
  role: Role;
  sessionId: string;
  restricted: boolean;
}
export class ApplicationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 422,
  ) {
    super(message);
  }
}
export function requireRole(actor: TenantActor, roles: Role[]) {
  if (!roles.includes(actor.role))
    throw new ApplicationError('FORBIDDEN', 'Permissão insuficiente.', 403);
}
