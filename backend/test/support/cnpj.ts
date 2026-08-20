import { randomUUID } from 'node:crypto';

/** CNPJ numérico aleatório com dígitos verificadores válidos, para lojas de teste. */
export function testCnpj() {
  const base = String(
    BigInt(`0x${randomUUID().replaceAll('-', '').slice(0, 12)}`) % 1000000000000n,
  ).padStart(12, '0');
  const digit = (value: string) => {
    let sum = 0,
      weight = 2;
    for (let i = value.length - 1; i >= 0; i--) {
      sum += Number(value[i]) * weight;
      weight = weight === 9 ? 2 : weight + 1;
    }
    return sum % 11 < 2 ? 0 : 11 - (sum % 11);
  };
  const first = digit(base);
  return base + first + digit(base + first);
}
