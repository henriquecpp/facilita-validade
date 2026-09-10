import { localToday } from './expiry-date';

/** Faixa de um nível de urgência: dias até vencer, negativo é vencido; nulo é sem limite. */
export interface LevelRange {
  minDays?: number | null;
  maxDays?: number | null;
}

/** Nome e cor da faixa sem nível, os mesmos do servidor. */
export const NO_LEVEL = { name: 'Sem nível', color: '#9e9e9e' } as const;

/** Dias de `today` até `date`, ambas datas civis `YYYY-MM-DD`; negativo se já passou. */
export function daysUntil(date: string, today: string): number {
  return Math.round(
    (Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000,
  );
}

/** Mesma regra do servidor: o nível cuja faixa cobre os dias; nenhum fora de todas. */
export function levelFor<T extends LevelRange>(levels: readonly T[], days: number): T | null {
  return (
    levels.find(
      (level) =>
        (level.minDays == null || days >= level.minDays) &&
        (level.maxDays == null || days <= level.maxDays),
    ) ?? null
  );
}

/** Prévia da hierarquia: ordena limites e deriva os inícios, como o servidor. */
export function levelHierarchy<T extends Pick<LevelRange, 'maxDays'>>(
  levels: readonly T[],
): (T & { minDays: number | null })[] {
  const sorted = [...levels].sort((a, b) => (a.maxDays ?? Infinity) - (b.maxDays ?? Infinity));
  return sorted.map((level, index) => ({
    ...level,
    minDays: index === 0 ? null : sorted[index - 1]!.maxDays! + 1,
  }));
}

/** Limites repetidos, incluindo dois níveis sem limite; sem arbitrar um desempate. */
export function duplicateLevelLimit<T extends Pick<LevelRange, 'maxDays'> & { name: string }>(
  levels: readonly T[],
): [string, string] | null {
  const seen = new Map<number | null, string>();
  for (const level of levels) {
    const limit = level.maxDays ?? null;
    if (seen.has(limit)) return [seen.get(limit)!, level.name];
    seen.set(limit, level.name);
  }
  return null;
}

/** "já vencidos", "de 0 a 5 dias", "a partir de 16 dias": a faixa em palavras. */
export function describeRange({ minDays, maxDays }: LevelRange): string {
  const days = (value: number) =>
    value < 0
      ? `${-value} ${value === -1 ? 'dia' : 'dias'} depois de vencer`
      : `${value} ${value === 1 ? 'dia' : 'dias'}`;
  if (minDays == null && maxDays == null) return 'qualquer prazo';
  if (minDays == null) return maxDays! === -1 ? 'já vencidos' : `até ${days(maxDays!)}`;
  if (maxDays == null) return `a partir de ${days(minDays)}`;
  if (minDays === maxDays) return minDays === 0 ? 'vence hoje' : days(minDays);
  return `de ${minDays} a ${days(maxDays)}`;
}

/**
 * Faixas que se sobrepõem, pela mesma regra do servidor: em ordem de início, cada uma
 * comparada à seguinte. Devolve os nomes do primeiro par, ou null.
 */
export function levelOverlap<T extends LevelRange & { name: string }>(
  levels: readonly T[],
): [string, string] | null {
  const start = (level: T) => level.minDays ?? Number.NEGATIVE_INFINITY;
  const end = (level: T) => level.maxDays ?? Number.POSITIVE_INFINITY;
  const sorted = [...levels].sort((a, b) => start(a) - start(b) || end(a) - end(b));
  for (let i = 1; i < sorted.length; i++)
    if (end(sorted[i - 1]!) >= start(sorted[i]!)) return [sorted[i - 1]!.name, sorted[i]!.name];
  return null;
}

/** "Venceu há 3 dias", "Venceu ontem", "Vence hoje", "Vence amanhã", "Vence em 5 dias". */
export function expiryText(days: number): string {
  if (days < -1) return `Venceu há ${-days} dias`;
  if (days === -1) return 'Venceu ontem';
  if (days === 0) return 'Vence hoje';
  if (days === 1) return 'Vence amanhã';
  return `Vence em ${days} dias`;
}

/**
 * Previsão de venda do lote pela média de vendas do produto: `ok` quando deve vender antes de
 * vencer. Sem previsão (histórico curto, lote vencido), nada.
 */
export function forecastText(
  leftover: number | null | undefined,
  quantity: number,
): { text: string; ok: boolean } | null {
  if (leftover === null || leftover === undefined) return null;
  if (leftover === 0) return { text: 'Deve vender antes de vencer', ok: true };
  if (leftover >= quantity) return { text: 'Não deve vender até a validade', ok: false };
  return { text: `Deve sobrar ${leftover} ${leftover === 1 ? 'unidade' : 'unidades'}`, ok: false };
}

/** Data civil de hoje no fuso da loja; sem fuso válido, a do navegador. */
export function storeToday(timeZone?: string, now = new Date()): string {
  if (!timeZone) return localToday(now);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const part = (type: string) => parts.find((item) => item.type === type)?.value ?? '';
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch {
    return localToday(now);
  }
}
