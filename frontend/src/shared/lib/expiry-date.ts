/**
 * Digitação da validade pelo teclado. Mesmas regras do app Android, conferidas pelos casos de
 * `contracts/fixtures/expiry-input.json`: só dígitos bastam (`12042026`), separadores `.`, `/`,
 * `-` ou espaço são aceitos e o ano pode ter dois dígitos (vira 20AA).
 */
const SEPARATOR = /[./\-\s]/;
const PART_LENGTH = [2, 2, 4] as const;
export const FAR_FUTURE_YEARS = 5;

/** Máscara progressiva `DD/MM/AAAA`, recalculada a partir de tudo que está no campo. */
export function maskExpiryInput(raw: string): string {
  const parts = ['', '', ''];
  let index = 0;
  for (const char of raw) {
    if (char >= '0' && char <= '9') {
      if (parts[index]!.length === PART_LENGTH[index]) {
        if (index === 2) continue;
        index += 1;
      }
      parts[index] += char;
    } else if (SEPARATOR.test(char) && index < 2 && parts[index]!.length > 0) {
      parts[index] = parts[index]!.padStart(2, '0');
      index += 1;
    }
  }
  return parts.slice(0, index + 1).join('/');
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** Converte o que foi digitado em data ISO `YYYY-MM-DD`, ou null se não for uma data real. */
export function parseExpiryInput(value: string): string | null {
  const text = value.trim();
  let day: string, month: string, year: string;
  if (/^\d+$/.test(text)) {
    if (text.length !== 6 && text.length !== 8) return null;
    [day, month, year] = [text.slice(0, 2), text.slice(2, 4), text.slice(4)];
  } else {
    const parts = text.split(/[./\-\s]+/);
    if (parts.length !== 3 || !parts.every((part) => /^\d+$/.test(part))) return null;
    [day, month, year] = parts as [string, string, string];
    if (day.length > 2 || month.length > 2 || (year.length !== 2 && year.length !== 4)) return null;
  }
  const y = Number(year.length === 2 ? `20${year}` : year);
  const m = Number(month);
  const d = Number(day);
  if (y < 2000 || y > 2099 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Datas legítimas, mas suspeitas de erro de digitação: pedem confirmação. */
export function expiryWarning(iso: string, today: string): 'PAST' | 'FAR' | null {
  if (iso < today) return 'PAST';
  const [year, rest] = [Number(today.slice(0, 4)), today.slice(4)];
  return iso > `${year + FAR_FUTURE_YEARS}${rest}` ? 'FAR' : null;
}

export const expiryWarningText = {
  PAST: 'Esta validade já passou. Confira antes de salvar.',
  FAR: `Validade a mais de ${FAR_FUTURE_YEARS} anos. Confira o ano antes de salvar.`,
} as const;

/** Data civil de hoje no fuso do navegador, `YYYY-MM-DD`. */
export function localToday(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
