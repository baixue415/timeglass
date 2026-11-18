/* 时璃 · 托盘图标生成：OaO.jpg → 32x32 PNG（assets/tray.png） */
'use strict';
const { Jimp } = require('jimp');
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'build', 'OaO.jpg');
const out = path.join(__dirname, '..', 'assets', 'tray.png');

(async () => {
  const img = await Jimp.read(src);
  const buf = await img.clone().cover({ w: 32, h: 32 }).getBuffer('image/png');
  fs.writeFileSync(out, buf);
  console.log('written:', out, buf.length, 'bytes');
})().catch(e => { console.error('maketray failed:', e); process.exit(1); });
