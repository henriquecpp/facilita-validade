/**
 * EAN-13 que não confere: 13 dígitos cujo último não é o verificador dos 12 primeiros (pesos 1
 * e 3 alternados, GS1). Um código assim foi digitado ou lido errado, e nem vale consultar. Só o
 * EAN-13 é conferido; os outros formatos seguem para a consulta.
 */
export function invalidEan13(code: string): boolean {
  if (!/^\d{13}$/.test(code)) return false;
  const sum = [...code.slice(0, 12)].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return (10 - (sum % 10)) % 10 !== Number(code[12]);
}
