/**
 * Níveis de urgência que cada loja define para as validades (17/10/2026, NV01).
 * Funções puras: sem banco, rede ou relógio.
 *
 * Cada nível tem um limite superior: zero é vencer hoje, negativos são lotes vencidos.
 * A ordem dos limites define faixas contíguas, com início aberto no primeiro nível. Um
 * único limite nulo abre o último nível; sem ele, dias acima do maior limite ficam sem
 * nível. minDays continua na leitura para clientes antigos, mas é sempre derivado.
 */
import { ApplicationError } from '../../../shared/domain/context.js';

export const MAX_LEVEL_DAYS = 36500;

export interface ExpiryLevelInput {
  readonly id?: string;
  readonly name: string;
  /** Compatibilidade de escrita: aceito, mas não define mais o começo da faixa. */
  readonly minDays?: number | null;
  readonly maxDays?: number | null;
  readonly color: string;
  readonly notify: boolean;
}

export interface ExpiryLevel {
  readonly id?: string;
  readonly name: string;
  readonly minDays: number | null;
  readonly maxDays: number | null;
  readonly color: string;
  readonly notify: boolean;
}

/** Faixa em texto, para mensagens: "até -1 dia", "de 0 a 5 dias", "a partir de 16 dias". */
export function describeRange(level: Pick<ExpiryLevel, 'minDays' | 'maxDays'>): string {
  const days = (value: number) => `${value} ${Math.abs(value) === 1 ? 'dia' : 'dias'}`;
  if (level.minDays === null && level.maxDays === null) return 'qualquer prazo';
  if (level.minDays === null) return `até ${days(level.maxDays!)}`;
  if (level.maxDays === null) return `a partir de ${days(level.minDays)}`;
  if (level.minDays === level.maxDays) return days(level.minDays);
  return `de ${level.minDays} a ${days(level.maxDays)}`;
}

const bound = (value: number | null | undefined, maximum = MAX_LEVEL_DAYS): number | null => {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < -MAX_LEVEL_DAYS || value > maximum)
    throw new ApplicationError('INVALID_LEVEL_RANGE', 'Os dias do nível precisam ser inteiros.');
  return value;
};

/**
 * Confere e normaliza a lista inteira de níveis da loja: nomes sem espaços sobrando e sem
 * repetição, cor `#rrggbb` minúscula e limites distintos. Ordena pelo limite e deriva o
 * início de cada faixa. Nunca cria Vencido/Em dia pelo nome ou um nível fora do cadastro.
 */
export function validateLevels(levels: readonly ExpiryLevelInput[]): ExpiryLevel[] {
  const names = new Set<string>();
  const ids = new Set<string>();
  const normalized = levels.map((level) => {
    const name = level.name.normalize('NFC').replace(/\s+/g, ' ').trim();
    if (!name || name.length > 40)
      throw new ApplicationError('INVALID_LEVEL_NAME', 'Dê ao nível um nome de 1 a 40 letras.');
    const key = name.toLocaleLowerCase('pt-BR');
    if (names.has(key))
      throw new ApplicationError('DUPLICATE_LEVEL_NAME', `Há dois níveis chamados "${name}".`);
    names.add(key);
    if (level.id !== undefined) {
      if (ids.has(level.id))
        throw new ApplicationError('DUPLICATE_LEVEL', 'O mesmo nível aparece duas vezes.');
      ids.add(level.id);
    }
    const color = level.color.trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(color))
      throw new ApplicationError('INVALID_LEVEL_COLOR', `Cor inválida no nível "${name}".`);
    // Clientes antigos ainda podem reenviar minDays. O servidor decide a hierarquia,
    // inclusive quando esse valor tentaria deixar uma lacuna ou sobrepor outra faixa.
    bound(level.minDays, MAX_LEVEL_DAYS + 1);
    const maxDays = bound(level.maxDays);
    return {
      ...(level.id ? { id: level.id } : {}),
      name,
      minDays: null,
      maxDays,
      color,
      notify: level.notify,
    };
  });
  const end = (level: ExpiryLevel) => level.maxDays ?? Number.POSITIVE_INFINITY;
  const sorted = normalized.toSorted((a, b) => end(a) - end(b));
  for (let i = 1; i < sorted.length; i++) {
    const previous = sorted[i - 1]!;
    const current = sorted[i]!;
    if (previous.maxDays === current.maxDays)
      throw new ApplicationError(
        'DUPLICATE_LEVEL_LIMIT',
        `Os níveis "${previous.name}" e "${current.name}" têm o mesmo limite. Use limites diferentes e apenas um nível sem limite.`,
      );
  }
  return sorted.map((level, index) => ({
    ...level,
    minDays: index === 0 ? null : sorted[index - 1]!.maxDays! + 1,
  }));
}

/** Nível de um lote com `days` dias até vencer; null quando nenhuma faixa o cobre. */
export function levelFor<T extends Pick<ExpiryLevel, 'minDays' | 'maxDays'>>(
  levels: readonly T[],
  days: number,
): T | null {
  return (
    levels.find(
      (level) =>
        (level.minDays === null || days >= level.minDays) &&
        (level.maxDays === null || days <= level.maxDays),
    ) ?? null
  );
}
