/* 时璃 · 应用图标生成：OaO.jpg → 多尺寸 ICO（Windows exe 图标）
   jimp 1.x 新 API */
'use strict';
const { Jimp } = require('jimp');
const pngToIco = require('png-to-ico').default || require('png-to-ico');
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'build', 'OaO.jpg');
const out = path.join(__dirname, '..', 'build', 'icon.ico');
const SIZES = [16, 24, 32, 48, 64, 128, 256];

(async () => {
  const img = await Jimp.read(src);
  console.log('source:', img.width + 'x' + img.height);
  const pngs = [];
  for (const s of SIZES) {
    const clone = img.clone();
    clone.cover({ w: s, h: s });
    const buf = await clone.getBuffer('image/png');
    pngs.push(buf);
  }
  const ico = await pngToIco(pngs);
  fs.writeFileSync(out, ico);
  console.log('written:', out, ico.length, 'bytes');
})().catch(e => { console.error('genicon failed:', e); process.exit(1); });
