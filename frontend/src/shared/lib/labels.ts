import type { Issue } from '../api/types';
import { formatDate, units } from './format';

/** O que a pendência significa e o que fazer, em vez do código interno. */
export function describeIssue(issue: Pick<Issue, 'type' | 'movementType' | 'quantity'>): {
  title: string;
  detail: string;
} {
  const amount = issue.quantity != null ? units(issue.quantity) : null;
  switch (issue.type) {
    case 'PENDING_STOCK_IDENTIFICATION':
      return issue.movementType === 'RETURN_RECEIPT'
        ? {
            title: 'Devolução sem validade',
            detail: `${amount ? `Chegou devolução de ${amount}` : 'Chegou uma devolução'} sem a validade. Informe a validade para somar ao estoque certo.`,
          }
        : {
            title: 'Descarte sem lote',
            detail: `${amount ? `O sistema da loja registrou o descarte de ${amount}` : 'O sistema da loja registrou um descarte'} sem dizer de qual validade. Indique o lote para descontar do lugar certo.`,
          };
    case 'UNALLOCATED_QUANTITY':
      return {
        title: 'Venda maior que o estoque',
        detail: `${amount ? `Foram vendidas ${amount}` : 'Foram vendidas unidades'} além do estoque estimado. Conte o produto para corrigir o saldo.`,
      };
    case 'UNALLOCATED_SCRAP':
      return {
        title: 'Descarte maior que o lote',
        detail: `${amount ? `O descarte passou ${amount}` : 'O descarte passou'} do saldo do lote indicado. Conte o produto para corrigir o saldo.`,
      };
    case 'PENDING_REFERENCE':
      return {
        title: 'Cancelamento sem a venda original',
        detail:
          'O sistema da loja cancelou uma movimentação que ainda não chegou. Costuma se resolver sozinho quando ela chegar.',
      };
    default:
      return {
        title: 'Pendência de estoque',
        detail: 'Confira o produto e, se preciso, faça uma contagem.',
      };
  }
}

/** Entrada soma, venda, descarte e baixa manual tiram; o resto ajusta outro registro. */
export function movementSign(type: string): '+' | '−' | '' {
  if (type === 'APP_RECEIPT' || type === 'RETURN_RECEIPT') return '+';
  if (type === 'SALE' || type === 'SCRAP' || type === 'MANUAL_WRITE_OFF') return '−';
  return '';
}

/** Situação de cada lote: com saldo, baixado (pelas vendas, à mão ou pelos dois), excluído. */
export const recordStatusLabels: Record<string, string> = {
  PENDING: 'Pendente',
  AUTOMATIC: 'Baixado automático',
  MANUAL: 'Baixado manual',
  BOTH: 'Baixado manual e automático',
  EMPTY: 'Sem saldo',
  DELETED: 'Excluído',
  REPLACED: 'Substituído pela contagem',
};
export const recordStatusTone: Record<string, 'EXPIRED' | 'HIGH' | 'MEDIUM' | 'OK' | 'NONE'> = {
  PENDING: 'MEDIUM',
  AUTOMATIC: 'OK',
  MANUAL: 'OK',
  BOTH: 'OK',
  EMPTY: 'NONE',
  DELETED: 'EXPIRED',
  REPLACED: 'NONE',
};

/** Origem do lote: a contagem, uma entrada pelo coletor ou painel, ou uma devolução. */
export const recordOriginLabels: Record<string, string> = {
  COUNT: 'Contagem',
  APP_RECEIPT: 'Entrada',
  RETURN_RECEIPT: 'Devolução',
};

/** Referência legível das importações automáticas; as demais aparecem como vieram. */
export function describeBatch(externalBatchId: string): string | null {
  const sales = /^pagonet:vendas:(\d{4}-\d{2}-\d{2})/.exec(externalBatchId);
  if (sales) return `Vendas de ${formatDate(sales[1])} (Pagonet)`;
  const catalog = /^pagonet:catalogo:.*:(\d+)$/.exec(externalBatchId);
  if (catalog) return `Catálogo da Pagonet · parte ${catalog[1]}`;
  return null;
}

const auditLabels: Record<string, string> = {
  AUTH_LOGIN: 'Entrou no sistema',
  AUTH_DEVICE_PAIRED: 'Entrou no coletor pelo QR',
  AUTH_REFRESH_RETRY: 'Sessão renovada após falha de conexão',
  AUTH_REFRESH_REUSE: 'Sessão encerrada por segurança',
  PASSWORD_CHANGED: 'Trocou a senha',
  PASSWORD_RESET_ISSUED: 'Gerou link para redefinir senha',
  PASSWORD_RESET_COMPLETED: 'Redefiniu a senha pelo link',
  USER_CREATED: 'Cadastrou usuário',
  USER_UPDATED: 'Alterou usuário',
  DEVICE_PAIRING_ISSUED: 'Gerou QR de acesso ao coletor',
  AUTH_DEVICE_SESSION_REVOKED: 'Desconectou um coletor',
  DEV_USER_PROVISIONED: 'Criou usuário de teste',
  PLATFORM_STORE_PROVISIONED: 'Cadastrou a loja',
  PLATFORM_OWNER_RESET_ISSUED: 'Recuperou o acesso do proprietário',
  PLATFORM_STORE_SUSPENDED: 'Suspendeu a loja',
  PLATFORM_STORE_REACTIVATED: 'Reativou a loja',
  'count.create': 'Iniciou contagem',
  'count.lines': 'Salvou quantidades da contagem',
  'count.confirm': 'Confirmou contagem',
  'count.cancel': 'Cancelou contagem',
  'inventory.receipt': 'Registrou entrada de mercadoria',
  'inventory.resolve': 'Resolveu divergência',
  'inventory.metadata': 'Alterou observação de lote',
  'inventory.write-off': 'Deu baixa manual em lote',
  'inventory.edit': 'Editou lote',
  'inventory.delete': 'Excluiu lote',
  'store.levels': 'Alterou os níveis de urgência',
  'inventory.rebuild': 'Recalculou o estoque',
  'import.process': 'Processou importação',
  'import.reprocess': 'Reprocessou importação',
  'integration.connection.create': 'Criou conexão de integração',
  'integration.connection.deactivate': 'Desativou conexão de integração',
  'integration.key.create': 'Gerou chave de integração',
  'integration.key.revoke': 'Revogou chave de integração',
  'notification.read': 'Marcou alerta como lido',
  'pagonet.configure': 'Configurou a Pagonet',
  'pagonet.sync': 'Forçou a leitura da Pagonet',
  'pagonet.catalog': 'Leu o catálogo da Pagonet',
  'pagonet.sales': 'Leu as vendas da Pagonet',
  'store.settings': 'Alterou as configurações',
};

export function auditLabel(action: string): string {
  return auditLabels[action] ?? action;
}

/** Campos de estoque explicitamente publicados pela API; nunca exibe o payload bruto da ação. */
export function auditDetail(details?: {
  quantity?: number;
  reason?: string;
  expiresOn?: string;
  previousQuantity?: number;
  previousExpiresOn?: string;
}): string {
  if (!details) return '';
  const parts: string[] = [];
  if (details.quantity != null)
    parts.push(
      details.previousQuantity != null
        ? `Quantidade: ${details.previousQuantity} → ${details.quantity}`
        : `Quantidade: ${details.quantity}`,
    );
  if (details.expiresOn)
    parts.push(
      details.previousExpiresOn
        ? `Validade: ${formatDate(details.previousExpiresOn)} → ${formatDate(details.expiresOn)}`
        : `Validade: ${formatDate(details.expiresOn)}`,
    );
  if (details.reason) parts.push(`Motivo: ${details.reason}`);
  return parts.join(' · ');
}
