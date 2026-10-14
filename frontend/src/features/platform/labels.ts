import type { PlatformEvent } from '../../shared/api/types';
import { formatCnpj } from '../../shared/lib/format';

/** Ações do histórico da plataforma, na linguagem de quem opera. */
export const platformActions: Record<string, string> = {
  PLATFORM_LOGIN: 'Entrou no painel',
  PLATFORM_PASSWORD_CHANGED: 'Trocou a própria senha',
  PLATFORM_ADMIN_CREATED: 'Criou administrador da plataforma',
  PLATFORM_ADMIN_RESET: 'Redefiniu a senha de administrador',
  PLATFORM_ADMIN_DEACTIVATED: 'Desativou administrador',
  PLATFORM_STORE_PROVISIONED: 'Cadastrou a loja',
  PLATFORM_STORE_SUSPENDED: 'Suspendeu a loja',
  PLATFORM_STORE_REACTIVATED: 'Reativou a loja',
  PLATFORM_OWNER_RESET_ISSUED: 'Gerou acesso para o proprietário',
};

/** "Usuário dona · Motivo: perdeu a senha". */
export function describeEvent(event: PlatformEvent): string {
  const { username, cnpj, reason } = event.detail;
  return [
    username ? `Usuário ${username}` : null,
    cnpj ? `CNPJ ${formatCnpj(cnpj)}` : null,
    reason ? `Motivo: ${reason}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}
