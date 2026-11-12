/**
 * Gera uma folha de códigos de barras EAN-13 para testar a leitura por câmera.
 *
 * Uso:
 *   node scripts/barcodes.mjs                      # códigos de exemplo
 *   node scripts/barcodes.mjs 7891000315507 ...    # códigos informados
 *   node scripts/barcodes.mjs --check 789100031550 # calcula o dígito verificador
 *
 * A saída é um HTML com SVG embutido: abra no navegador e aponte a câmera, ou
 * imprima. Nada externo é carregado, então funciona sem internet.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// Padrões EAN-13. L e G codificam a metade esquerda; R, a direita.
const L = [
  '0001101',
  '0011001',
  '0010011',
  '0111101',
  '0100011',
  '0110001',
  '0101111',
  '0111011',
  '0110111',
  '0001011',
];
const G = [
  '0100111',
  '0110011',
  '0011011',
  '0100001',
  '0011101',
  '0111001',
  '0000101',
  '0010001',
  '0001001',
  '0010111',
];
const R = L.map((bits) => bits.replace(/[01]/g, (b) => (b === '0' ? '1' : '0')));
// A paridade da metade esquerda é o que codifica o primeiro dígito.
const PARITY = [
  'LLLLLL',
  'LLGLGG',
  'LLGGLG',
  'LLGGGL',
  'LGLLGG',
  'LGGLLG',
  'LGGGLL',
  'LGLGLG',
  'LGLGGL',
  'LGGLGL',
];

/** Dígito verificador de um EAN-13 a partir dos 12 primeiros dígitos. */
export function checkDigit(twelve) {
  if (!/^[0-9]{12}$/.test(twelve)) throw new Error(`Esperado 12 dígitos: ${twelve}`);
  const sum = [...twelve].reduce((acc, d, i) => acc + Number(d) * (i % 2 === 0 ? 1 : 3), 0);
  return String((10 - (sum % 10)) % 10);
}

export function isValidEan13(code) {
  return /^[0-9]{13}$/.test(code) && checkDigit(code.slice(0, 12)) === code[12];
}

/** Sequência de barras (1) e espaços (0) de um EAN-13 completo. */
function encode(code) {
  if (!isValidEan13(code)) throw new Error(`EAN-13 inválido: ${code}`);
  const parity = PARITY[Number(code[0])];
  let bits = '101';
  for (let i = 1; i <= 6; i++) {
    const digit = Number(code[i]);
    bits += parity[i - 1] === 'L' ? L[digit] : G[digit];
  }
  bits += '01010';
  for (let i = 7; i <= 12; i++) bits += R[Number(code[i])];
  return bits + '101';
}

/**
 * SVG do código. As guardas descem abaixo da área de barras para deixar espaço
 * ao texto, como numa etiqueta real.
 */
export function svg(code, { unit = 3, height = 90, pad = 12 } = {}) {
  const bits = encode(code);
  const width = bits.length * unit + pad * 2;
  const total = height + 34;
  const longBar = (i) =>
    i < 3 || (i >= 45 && i < 50) || i >= bits.length - 3 ? height + 10 : height;
  let bars = '';
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === '1')
      bars += `<rect x="${pad + i * unit}" y="8" width="${unit}" height="${longBar(i)}"/>`;
  }
  const text = (x, value, anchor) =>
    `<text x="${x}" y="${total - 4}" font-family="monospace" font-size="15" text-anchor="${anchor}">${value}</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${total}" viewBox="0 0 ${width} ${total}">
  <rect width="${width}" height="${total}" fill="#fff"/>
  <g fill="#000">${bars}</g>
  ${text(pad - 2, code[0], 'end')}
  ${text(pad + 27 * unit, code.slice(1, 7), 'middle')}
  ${text(pad + 74 * unit, code.slice(7), 'middle')}
</svg>`;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/**
 * PNG em tons de cinza, sem dependência externa. O código de barras é um raster
 * trivial — colunas pretas e brancas —, então vale escrever o encoder aqui em vez
 * de trazer uma biblioteca só para isso.
 *
 * Não desenha os dígitos: o leitor não precisa deles e o nome do arquivo já os traz.
 */
function png(code, { unit = 6, bars = 220, quiet = 12, margin = 20 } = {}) {
  const bits = encode(code);
  const width = (bits.length + quiet * 2) * unit;
  const height = bars + margin * 2;
  const row = Buffer.alloc(width, 0xff);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i] === '1') row.fill(0x00, (quiet + i) * unit, (quiet + i + 1) * unit);
  }
  const blank = Buffer.alloc(width, 0xff);
  const scanlines = [];
  for (let y = 0; y < height; y++) {
    scanlines.push(Buffer.from([0])); // filtro 0 (nenhum)
    scanlines.push(y < margin || y >= margin + bars ? blank : row);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // profundidade
  ihdr[9] = 0; // tons de cinza
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(scanlines))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Só executa a CLI quando chamado direto; importado, o arquivo é só as funções acima.
if (process.argv[1]?.endsWith('barcodes.mjs')) {
  const args = process.argv.slice(2);

  if (args[0] === '--check') {
    for (const base of args.slice(1)) console.log(base + checkDigit(base));
    process.exit(0);
  }

  // Prefixo 789 é o da GS1 Brasil; estes são códigos de teste, não produtos reais.
  const DEFAULT = ['789000000001', '789000000002', '789000000003', '789000000004'].map(
    (base) => base + checkDigit(base),
  );

  const wantsPng = args.includes('--png');
  const codes = args.filter((a) => a !== '--png');
  if (!codes.length) codes.push(...DEFAULT);
  const invalid = codes.filter((c) => !isValidEan13(c));
  if (invalid.length) {
    console.error(`EAN-13 inválido: ${invalid.join(', ')}`);
    console.error('Use --check com os 12 primeiros dígitos para obter o verificador.');
    process.exit(1);
  }

  if (wantsPng) {
    const dir = process.env.BARCODES_DIR ?? 'barcodes';
    mkdirSync(dir, { recursive: true });
    for (const code of codes) {
      const file = `${dir}/${code}.png`;
      writeFileSync(file, png(code));
      console.log(file);
    }
    process.exit(0);
  }

  const cards = codes
    .map(
      (code) =>
        `    <figure>\n      ${svg(code)}\n      <figcaption>${code}</figcaption>\n    </figure>`,
    )
    .join('\n');

  const html = `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<title>Códigos de barras para teste</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 24px; background: #fff; color: #111; }
  h1 { font-size: 18px; }
  p { font-size: 14px; max-width: 60ch; color: #444; }
  .sheet { display: flex; flex-wrap: wrap; gap: 28px; margin-top: 20px; }
  figure { margin: 0; text-align: center; }
  figcaption { font-family: monospace; font-size: 13px; margin-top: 4px; color: #444; }
  @media print { p, h1 { display: none; } }
</style>
</head>
<body>
  <h1>Códigos de barras para teste</h1>
  <p>Aponte a câmera do coletor para um código. Se estiver lendo da tela, aumente o
  brilho e afaste alguns centímetros; papel impresso lê melhor que tela.</p>
  <div class="sheet">
${cards}
  </div>
</body>
</html>`;

  const out = process.env.BARCODES_OUT ?? 'barcodes.html';
  writeFileSync(out, html);
  console.log(`${codes.length} código(s) em ${out}`);
}
