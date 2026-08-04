/** EAN-13 válido a partir dos 12 primeiros dígitos (dígito verificador GS1), para os testes. */
export function ean13(twelve: string): string {
  if (!/^\d{12}$/.test(twelve)) throw new Error(`Esperados 12 dígitos: ${twelve}`);
  const sum = [...twelve].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return `${twelve}${(10 - (sum % 10)) % 10}`;
}
