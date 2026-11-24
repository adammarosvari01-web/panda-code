// Generates panda.ico (PNG-compressed entries at 16/24/32/48/64/128/256 px) with no dependencies.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const GRID = [
  '..KKK......KKK..',
  '.KKKKWWWWWWKKKK.',
  '.KKKWWWWWWWWKKK.',
  '..WWWWWWWWWWWW..',
  '.WWKKKWWWWKKKWW.',
  '.WKKWKKWWKKWKKW.',
  '.WKKKKWWWWKKKKW.',
  '.WPWKKWWWWKKWPW.',
  '.WWWWWWKKWWWWWW.',
  '..WWWKWKKWKWWW..',
  '...WWWKWWKWWW...',
  '.....WWWWWW.....',
];
const COL = { K: [28, 28, 34, 255], W: [250, 250, 250, 255], P: [240, 150, 180, 255] };
const BG = [122, 201, 92, 255];

function render(N) {
  const px = Buffer.alloc(N * N * 4);
  const cells = 20; // 16x12 grid centered in a 20x20 cell canvas
  const ox = 2, oy = 4;
  const r = N * 0.22; // corner radius of the bamboo-green tile
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    // rounded square background with anti-aliased edge
    const cx = Math.min(Math.max(x + 0.5, r), N - r), cy = Math.min(Math.max(y + 0.5, r), N - r);
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
    const a = Math.max(0, Math.min(1, r - d + 0.5));
    let c = [BG[0], BG[1], BG[2], Math.round(255 * a)];
    const gx = Math.floor(((x + 0.5) / N) * cells) - ox, gy = Math.floor(((y + 0.5) / N) * cells) - oy;
    if (a > 0 && gy >= 0 && gy < GRID.length && gx >= 0 && gx < 16) {
      const k = GRID[gy][gx];
      if (COL[k]) c = [...COL[k].slice(0, 3), Math.round(255 * a)];
    }
    px.set(c, (y * N + x) * 4);
  }
  return px;
}

const CRC = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(N) {
  const px = render(N);
  const raw = Buffer.alloc(N * (N * 4 + 1));
  for (let y = 0; y < N; y++) { raw[y * (N * 4 + 1)] = 0; px.copy(raw, y * (N * 4 + 1) + 1, y * N * 4, (y + 1) * N * 4); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(N, 0); ihdr.writeUInt32BE(N, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const imgs = sizes.map(png);
const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = Buffer.concat(sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s; e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(imgs[i].length, 8); e.writeUInt32LE(offset, 12); offset += imgs[i].length;
  return e;
}));
const outDir = process.argv[2] || path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'panda.ico'), Buffer.concat([head, dir, ...imgs]));
fs.writeFileSync(path.join(outDir, 'panda-256.png'), imgs[imgs.length - 1]);
console.log('Wrote', path.join(outDir, 'panda.ico'));
