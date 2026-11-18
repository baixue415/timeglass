/* 时璃 · 托盘图标生成（纯 Node，无依赖）
   32×32 沙漏 + 外环，琥珀色，透明背景 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 32, H = 32;
const px = new Uint8Array(W * H * 4);

function set(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  // 简单 alpha 合成（重复覆盖取不透明优先）
  if (px[i + 3] <= a) { px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a; }
}

// 上三角（沙漏上半）
function triTop(x, y) { return y >= 4 && y <= 14 && x >= 8 + (y - 4) * (8 / 10) && x <= 24 - (y - 4) * (8 / 10); }
// 下三角
function triBot(x, y) { return y >= 18 && y <= 28 && x >= 8 + (28 - y) * (8 / 10) && x <= 24 - (28 - y) * (8 / 10); }
// 腰线
function waist(x, y) { return y >= 15 && y <= 17 && x >= 14 && x <= 18; }
// 外环（1.5px 环）
function ring(x, y) {
  const cx = 15.5, cy = 15.5, d = Math.hypot(x - cx, y - cy);
  return d >= 13 && d <= 14.4;
}

for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (ring(x, y)) set(x, y, 255, 232, 214, 255);
    if (triTop(x, y) || triBot(x, y) || waist(x, y)) set(x, y, 255, 182, 138, 255);
  }
}

/* ---- PNG 封装 ---- */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// 原始数据：每行 filter=0 + RGBA
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y++) {
  raw[y * (1 + W * 4)] = 0;
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    const o = y * (1 + W * 4) + 1 + x * 4;
    raw[o] = px[i]; raw[o + 1] = px[i + 1]; raw[o + 2] = px[i + 2]; raw[o + 3] = px[i + 3];
  }
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0))
]);
const out = path.join(__dirname, '..', 'assets', 'tray.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('written', out, png.length, 'bytes');
