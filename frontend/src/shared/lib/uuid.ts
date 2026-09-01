/**
 * UUID v4 para chaves idempotentes e linhas novas. `crypto.randomUUID` só existe em contexto
 * seguro (HTTPS ou localhost): com o painel aberto pelo IP da máquina, em HTTP — no celular,
 * pela rede local —, ele não existe e todo envio quebraria. `getRandomValues` existe sempre.
 */
export function randomUuid(): string {
  const native = (crypto as Partial<Crypto>).randomUUID;
  if (native) return native.call(crypto);
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte, index) =>
    // Versão 4 e variante RFC 4122, como o do navegador.
    (index === 6 ? (byte & 0x0f) | 0x40 : index === 8 ? (byte & 0x3f) | 0x80 : byte)
      .toString(16)
      .padStart(2, '0'),
  ).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
