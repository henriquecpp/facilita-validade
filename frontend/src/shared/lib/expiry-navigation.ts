import type { LevelRange } from './risk';

/** Primeiro nível cadastrado que inclui prazos de hoje em diante, independentemente do nome. */
export function expiringLevel<T extends LevelRange>(levels: readonly T[]): T | null {
  return (
    [...levels]
      .filter((level) => level.maxDays == null || level.maxDays >= 0)
      .sort(
        (a, b) => (a.maxDays ?? Number.POSITIVE_INFINITY) - (b.maxDays ?? Number.POSITIVE_INFINITY),
      )[0] ?? null
  );
}
