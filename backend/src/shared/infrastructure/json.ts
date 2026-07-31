import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Valor para uma coluna jsonb: exatamente o que `JSON.stringify` gravaria — datas
 * viram texto ISO e propriedades `undefined` somem. Assim o que se lê de volta é
 * igual, campo a campo, ao que a API respondeu na primeira vez.
 */
export function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
