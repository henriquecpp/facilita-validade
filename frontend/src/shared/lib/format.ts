export function normalizeCnpj(value: string): string {
  return value
    .trim()
    .toUpperCase()
    .replace(/[.\/\-\s]/g, '');
}
export function formatCnpj(value: string): string {
  const clean = normalizeCnpj(value);
  return clean.length === 14
    ? `${clean.slice(0, 2)}.${clean.slice(2, 5)}.${clean.slice(5, 8)}/${clean.slice(8, 12)}-${clean.slice(12)}`
    : value;
}
export function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match) return `${match[3]}/${match[2]}/${match[1]}`;
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? '—'
    : new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(date);
}
/** "agora há pouco", "há 12 min", "há 3 h", "hoje às 14:20", "ontem às 14:20" ou a data. */
export function formatSince(value: string | null | undefined, now = new Date()): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const minutes = Math.floor((now.getTime() - date.getTime()) / 60000);
  if (minutes < 2) return 'agora há pouco';
  if (minutes < 60) return `há ${minutes} min`;
  if (minutes < 6 * 60) return `há ${Math.floor(minutes / 60)} h`;
  const time = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(
    date,
  );
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (date >= today) return `hoje às ${time}`;
  if (date.getTime() >= today.getTime() - 86_400_000) return `ontem às ${time}`;
  return formatDate(value);
}
export function integer(value: number): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 }).format(value);
}
/** `9,5`: até uma casa decimal. */
export function decimal(value: number): string {
  return new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(value);
}
/** R$ 1.234,56. */
export function money(value: number): string {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value);
}
/** R$ 1,2 mil, para os números grandes do painel. */
export function compactMoney(value: number): string {
  return Math.abs(value) < 10000
    ? money(value)
    : new Intl.NumberFormat('pt-BR', {
        style: 'currency',
        currency: 'BRL',
        notation: 'compact',
        maximumFractionDigits: 1,
      }).format(value);
}
/** `1 unidade`, `12 unidades`. */
export function units(value: number): string {
  return `${integer(value)} ${value === 1 ? 'unidade' : 'unidades'}`;
}
/** "Terça-feira, 13 de outubro", no fuso da loja quando informado. */
export function longToday(timeZone?: string, now = new Date()): string {
  const format = (zone?: string) =>
    new Intl.DateTimeFormat('pt-BR', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
      timeZone: zone,
    }).format(now);
  let text: string;
  try {
    text = format(timeZone);
  } catch {
    text = format();
  }
  return text.charAt(0).toUpperCase() + text.slice(1);
}
export const roleLabels = { OWNER: 'Proprietário', MANAGER: 'Gestor', OPERATOR: 'Operador' };
export const statusLabels: Record<string, string> = {
  COUNTING: 'Em andamento',
  CONFIRMED: 'Confirmada',
  CANCELLED: 'Cancelada',
  UNTRACKED: 'Sem contagem inicial',
  TRACKED: 'Controlado',
  ACTIVE: 'Controlado',
  RECEIVED: 'Recebida',
  PROCESSING: 'Processando',
  COMPLETED: 'Concluída',
  COMPLETED_WITH_ISSUES: 'Concluída com pendências',
  FAILED: 'Falhou',
  MEDIUM: 'Atenção',
  HIGH: 'Urgente',
  EXPIRED: 'Vencido',
  INFO: 'Informação',
  SALE: 'Venda',
  SCRAP: 'Descarte',
  RETURN_RECEIPT: 'Devolução',
  APP_RECEIPT: 'Entrada',
  VOID_MOVEMENT: 'Cancelamento',
  MANUAL_WRITE_OFF: 'Baixa manual',
  RECORD_EDIT: 'Edição do lote',
  RECORD_DELETE: 'Exclusão do lote',
  OPEN: 'Aberta',
  RESOLVED: 'Resolvida',
};
