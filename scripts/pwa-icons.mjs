/**
 * Ícones do painel instalável (PWA), desenhados aqui mesmo, sem dependência: um calendário
 * com um visto, branco sobre o verde da marca. Gera os PNG em frontend/public/icons.
 *
 * Uso: node scripts/pwa-icons.mjs
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';

const OUT = resolve(import.meta.dirname, '../frontend/public/icons');
const BRAND = [0x24, 0x5d, 0x4b];
const WHITE = [0xff, 0xff, 0xff];

/** Desenho num quadro de 512: cada forma diz se um ponto está dentro dela. */
const roundRect = (x0, y0, x1, y1, r) => (x, y) => {
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return x >= x0 && x <= x1 && y >= y0 && y <= y1 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const segment = (ax, ay, bx, by, r) => (x, y) => {
  const dx = bx - ax;
  const dy = by - ay;
  const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
  return (x - ax - t * dx) ** 2 + (y - ay - t * dy) ** 2 <= r * r;
};

/** Calendário (contorno, faixa de cima e argolas) com o visto, centrado em `scale`. */
function glyph(scale) {
  const c = 256;
  const s = (value) => c + (value - c) * scale;
  const outer = roundRect(s(132), s(150), s(380), s(392), 40 * scale);
  const inner = roundRect(s(160), s(178), s(352), s(364), 18 * scale);
  const band = roundRect(s(132), s(150), s(380), s(232), 40 * scale);
  const rings = [
    segment(s(200), s(118), s(200), s(176), 16 * scale),
    segment(s(312), s(118), s(312), s(176), 16 * scale),
  ];
  const check = [
    segment(s(196), s(298), s(238), s(338), 17 * scale),
    segment(s(238), s(338), s(318), s(258), 17 * scale),
  ];
  return (x, y) =>
    (outer(x, y) && !inner(x, y)) ||
    band(x, y) ||
    rings.some((shape) => shape(x, y)) ||
    check.some((shape) => shape(x, y));
}

/**
 * Rasteriza com 4×4 amostras por pixel. `background`: forma do fundo verde (null deixa
 * transparente); `mark`: forma branca; `ink`: cor da marca.
 */
function render(size, background, mark, ink = WHITE) {
  const pixels = Buffer.alloc(size * size * 4);
  const grid = 4;
  for (let py = 0; py < size; py++)
    for (let px = 0; px < size; px++) {
      let bg = 0;
      let fg = 0;
      for (let sy = 0; sy < grid; sy++)
        for (let sx = 0; sx < grid; sx++) {
          const x = ((px + (sx + 0.5) / grid) / size) * 512;
          const y = ((py + (sy + 0.5) / grid) / size) * 512;
          if (mark(x, y)) fg++;
          else if (background?.(x, y)) bg++;
        }
      const total = grid * grid;
      const alpha = (bg + fg) / total;
      const offset = (py * size + px) * 4;
      if (!alpha) continue;
      for (let channel = 0; channel < 3; channel++)
        pixels[offset + channel] = Math.round(
          ((bg / total) * BRAND[channel] + (fg / total) * ink[channel]) / alpha,
        );
      pixels[offset + 3] = Math.round(alpha * 255);
    }
  return png(size, pixels);
}

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, tail]);
}
function png(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bits por canal
  header[9] = 6; // RGBA
  const rows = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++)
    pixels.copy(rows, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
const tile = roundRect(0, 0, 512, 512, 112);
const full = () => true;
const files = {
  // Ícone comum: quadrado arredondado.
  'icon-192.png': render(192, tile, glyph(1)),
  'icon-512.png': render(512, tile, glyph(1)),
  // Maskable: fundo até a borda e o desenho dentro da zona segura (80% do centro).
  'icon-maskable-512.png': render(512, full, glyph(0.78)),
  'apple-touch-icon.png': render(180, full, glyph(0.86)),
  // Selo da notificação no Android: só a forma, branca sobre transparente.
  'badge-96.png': render(96, null, glyph(1.12)),
};
for (const [name, data] of Object.entries(files)) writeFileSync(join(OUT, name), data);
console.log(`Ícones gerados em ${OUT}: ${Object.keys(files).join(', ')}`);
