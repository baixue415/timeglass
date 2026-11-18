/* ============================================================
   时璃 Timeglass · Monet 取色引擎（自 monet-glass-shell 移植）
   壁纸 → seed → HCT 色板 → 分区采样 → 合成色 → 对比度求解 → 令牌下发
   供 renderer/app.js 调用；不依赖任何 DOM 结构假设之外的东西。
   ============================================================ */
(() => {
'use strict';
const M = window.MCU;

/* ---------------- 基础色彩工具 ---------------- */
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lin = v => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
const lum = c => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
const argbToRgb = n => ({ r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 });
const rgbToArgb = c => (0xff000000 | (Math.round(c.r) << 16) | (Math.round(c.g) << 8) | Math.round(c.b)) >>> 0;
const toHex = c => '#' + [c.r, c.g, c.b].map(v => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0')).join('');
const hexToRgb = h => { h = h.replace('#', ''); if (h.length === 3) h = h.split('').map(x => x + x).join('');
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) }; };
const mix = (G, B, a) => ({ r: G.r * a + B.r * (1 - a), g: G.g * a + B.g * (1 - a), b: G.b * a + B.b * (1 - a) });
const rgba = (c, a) => `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${(+a).toFixed(3)})`;

/* ---------------- 状态 ---------------- */
const S = {
  wall: 'amber',                 // 内置渐变名（无图片时的兜底）
  img: null,                      // 导入的壁纸 Image（或 dataURL Image）
  imgDataUrl: null,               // 持久化用：壁纸 dataURL
  auto: true,                     // 对比度不达标时允许自动抬升 α
  seedMode: 'ring',               // 采样方式：ring=整体色调 cluster=主色簇
  manualSeed: 0,                  // 手动主题色覆盖（0 = 跟随采样结果）
  candidates: [],
  mode: 'dark',                   // dark / light / 'system'
  activeMode: 'dark',
  wallTone: 40,
  params: { alpha: .78, blur: 24, radius: 1, shadow: 1 },
  slots: { nav: .12, card: -.10, input: -.04, list: -.12, rail: -.28 },
  seed: 0, hct: null, pal: null,
  lastQ: null, recomputeSeed: true, // 量化结果缓存 + 重算标志（QuantizerCelebi 非确定性，必须复用）
  bg: null, sampleData: null, SW: 200, SH: 125,
  results: []
};

/* ---------------- 皮肤包三层 ---------------- */
const LAYERS = {
  base: {
    name: '基础 · 深色', version: 'v1.2', builtin: true, enabled: true,
    mode: 'dark', seedMode: 'ring',
    params: { alpha: .78, blur: 24, radius: 1, shadow: 1 },
    slots: { nav: .12, card: -.10, input: -.04, list: -.12, rail: -.28 }
  },
  app: {
    name: '玻璃增强', version: 'v0.4', enabled: true,
    slots: { nav: .16, card: -.14, input: -.06, list: -.16, rail: -.30 }
  },
  user: { name: '我的覆盖', params: {}, slots: {}, mode: null }
};
let LAYER_ORDER = ['user', 'app', 'base'];

function resolveLayers() {
  const out = { params: {}, slots: {}, mode: null, seedMode: 'ring' };
  for (let i = LAYER_ORDER.length - 1; i >= 0; i--) {
    const L = LAYERS[LAYER_ORDER[i]];
    if (!L || L.enabled === false) continue;
    if (L.params) Object.assign(out.params, L.params);
    if (L.slots) Object.assign(out.slots, L.slots);
    if (L.mode) out.mode = L.mode;
    if (L.seedMode) out.seedMode = L.seedMode;
  }
  return out;
}

function syncAll() {
  const R = resolveLayers();
  S.params = Object.assign({}, R.params);
  S.slots = Object.assign({}, R.slots);
  S.mode = R.mode || 'dark';
  // 采样方式只有 ring/cluster；旧数据里的 manual 映射回 ring（手选已改为独立覆盖）
  S.seedMode = (R.seedMode === 'manual' ? 'ring' : R.seedMode) || 'ring';
  S.manualSeed = LAYERS.user.manualSeed || 0;
  apply();
}

function setUser(section, key, val) {
  if (section === 'mode') LAYERS.user.mode = val;
  else if (section === 'seedMode') LAYERS.user.seedMode = val;
  else if (section === 'manualSeed') LAYERS.user.manualSeed = val;
  else LAYERS.user[section][key] = val;
  syncAll();
  saveState();
}

function clearUser() {
  LAYERS.user.params = {};
  LAYERS.user.slots = {};
  LAYERS.user.mode = null;
  LAYERS.user.seedMode = undefined;
  LAYERS.user.manualSeed = 0;
  buildPal(extractSeed());
  syncAll();
  saveState();
}

/* 内置兜底渐变（没有导入壁纸时用，色相即产品默认基调） */
const WALLS = {
  amber:  { stops: [[0, '#0d0d1a'], [.42, '#291c21'], [.74, '#8a4e32'], [1, '#e09a5e']],
            glow: 'rgba(255,186,120,.55)', gx: 0.62, gy: 0.78, gr: 0.55 },
  cyan:   { stops: [[0, '#0b1a21'], [.5, '#2e6b72'], [1, '#a8cbd6']],
            glow: 'rgba(150,220,235,.42)', gx: 0.34, gy: 0.62, gr: 0.5 },
  violet: { stops: [[0, '#160f22'], [.5, '#4a2e5c'], [1, '#c88ba8']],
            glow: 'rgba(226,160,200,.45)', gx: 0.7, gy: 0.55, gr: 0.5 }
};
const SHADOWS = ['none', '0 8px 24px rgba(0,0,0,.20)', '0 16px 40px rgba(0,0,0,.32)', '0 24px 64px rgba(0,0,0,.40)'];
const RADIUS_BASE = { sm: 8, md: 12, lg: 20 };
const TARGET_CR = 4.5;

function slotAlpha(userA, off) {
  const k = 4 * userA * (1 - userA);
  return clamp(userA + (off || 0) * k, 0, 1);
}

const TONES = [15, 12, 18, 22, 26, 30, 34, 38, 42, 10, 46, 52, 58, 64, 70, 78];
const LIGHT_TONES = [96, 94, 92, 90, 88, 86, 84, 80, 98, 76, 72, 68, 62];

/* ---------------- 壁纸画布 ---------------- */
function drawWallpaper() {
  let c = document.getElementById('tg-wpcanvas');
  if (!c) { c = document.createElement('canvas'); c.id = 'tg-wpcanvas'; document.body.prepend(c); }
  const W = 1600, H = 1000;
  c.width = W; c.height = H;
  const g = c.getContext('2d');
  if (S.img) {
    const ir = S.img.width / S.img.height, cr2 = W / H;
    let dw = W, dh = H, dx = 0, dy = 0;
    if (ir > cr2) { dw = H * ir; dx = (W - dw) / 2; } else { dh = W / ir; dy = (H - dh) / 2; }
    g.drawImage(S.img, dx, dy, dw, dh);
  } else {
    const d = WALLS[S.wall] || WALLS.amber;
    const lg = g.createLinearGradient(0, 0, 0, H);
    d.stops.forEach(([p, col]) => lg.addColorStop(p, col));
    g.fillStyle = lg; g.fillRect(0, 0, W, H);
    const cx = d.gx * W, cy = d.gy * H, rr = d.gr * Math.max(W, H);
    const rg = g.createRadialGradient(cx, cy, 0, cx, cy, rr);
    rg.addColorStop(0, d.glow); rg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = rg; g.fillRect(0, 0, W, H);
  }
  S.bg = c;
  S.recomputeSeed = true; // 壁纸内容变化，标记下次取色需重新量化
}

function avgWallTone() {
  const t = document.createElement('canvas');
  t.width = 32; t.height = 20;
  const tg = t.getContext('2d');
  const w = S.bg.width, h = S.bg.height;
  tg.drawImage(S.bg, w * .25, h * .25, w * .5, h * .5, 0, 0, 32, 20);
  const d = tg.getImageData(0, 0, 32, 20).data;
  let r = 0, g = 0, b = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; n++; }
  return M.Hct.fromInt(rgbToArgb({ r: r / n, g: g / n, b: b / n })).tone;
}

function resolveMode() {
  if (S.mode === 'light' || S.mode === 'dark') return S.mode;
  return (window.api && window.api.system && window.api.system.prefersColorScheme && window.api.system.prefersColorScheme() === 'light')
    ? 'light'
    : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
}

/* ---------------- 取色 ---------------- */
const SEED_SAMPLE_W = 160, SEED_SAMPLE_H = 90, SEED_COLORS = 128;

function extractSeed() {
  // 量化结果缓存：QuantizerCelebi 非确定性（两次相同输入结果不同），
  // 若每次重算会导致候选卡 seed 反复变化、手选种子「点不中/无勾选」。
  // 只有换壁纸（recomputeSeed=true）才重新量化，其余复用 S.lastQ。
  if (S.recomputeSeed || !S.lastQ) {
    const t = document.createElement('canvas');
    t.width = SEED_SAMPLE_W; t.height = SEED_SAMPLE_H;
    const tg = t.getContext('2d');
    tg.drawImage(S.bg, 0, 0, SEED_SAMPLE_W, SEED_SAMPLE_H);
    const d = tg.getImageData(0, 0, SEED_SAMPLE_W, SEED_SAMPLE_H).data;
    const px = [];
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 128) continue;
      px.push(rgbToArgb({ r: d[i], g: d[i + 1], b: d[i + 2] }));
    }
    try {
      const q = M.QuantizerCelebi.quantize(px, SEED_COLORS);
      S.lastQ = q;
      S.candidates = pickCandidates(q);
      S.recomputeSeed = false;
    } catch (e) {
      console.warn('quantize failed', e);
      S.lastQ = null;
    }
  }
  if (!S.lastQ) return rgbToArgb({ r: 201, g: 123, b: 74 });
  const q = S.lastQ;
  const scored = M.Score.score(q);
  // 手动主题色覆盖优先（独立于采样方式：点了候选色就是覆盖，不改变采样方式）
  if (S.manualSeed) return S.manualSeed;
  if (scored && scored.length) {
    if (S.seedMode === 'cluster') return scored[0];
    const ring = ringSeed(q);
    if (M.Hct.fromInt(ring).chroma >= 8) return ring;
    return scored[0];
  }
  return rgbToArgb({ r: 201, g: 123, b: 74 });
}

function pickCandidates(q) {
  const out = [];
  const ring = ringSeed(q);
  if (ring) out.push({ seed: ring, tag: '整体', role: 'ring' });
  const scored = M.Score.score(q);
  scored.forEach((n, i) => {
    if (out.length >= 4) return;
    const h = M.Hct.fromInt(n);
    if (i > 0) {
      const distinct = out.every(o => {
        const oh = M.Hct.fromInt(o.seed);
        let dh = Math.abs(oh.hue - h.hue); dh = Math.min(dh, 360 - dh);
        return dh > 28 || Math.abs(oh.tone - h.tone) > 28;
      });
      if (!distinct) return;
    }
    out.push({ seed: n, tag: 'H' + h.hue.toFixed(0), role: i === 0 ? 'cluster' : null });
  });
  if (out.length < 4) {
    const base = out[0].seed;
    const bh = M.Hct.fromInt(base);
    [24, -24, 48].forEach(d => {
      if (out.length >= 4) return;
      const nh = ((bh.hue + d) % 360 + 360) % 360;
      out.push({ seed: M.Hct.from(nh, bh.chroma, bh.tone).toInt(), tag: (d > 0 ? '+' : '') + d + '°', role: null });
    });
  }
  return out;
}

function ringSeed(q) {
  let sx = 0, sy = 0, wsum = 0, csum = 0, tsum = 0;
  for (const [argb, count] of q) {
    const h = M.Hct.fromInt(argb);
    const w = Math.pow(Math.max(h.chroma, 0.5), 2) * count;
    const rad = h.hue * Math.PI / 180;
    sx += Math.cos(rad) * w;
    sy += Math.sin(rad) * w;
    wsum += w; csum += h.chroma * w; tsum += h.tone * w;
  }
  if (!wsum) return 0;
  const hue = (Math.atan2(sy, sx) * 180 / Math.PI + 360) % 360;
  return M.Hct.from(hue, csum / wsum, tsum / wsum).toInt();
}

function buildPal(seed) {
  S.seed = seed;
  S.hct = M.Hct.fromInt(seed);
  const cp = M.CorePalette.of(seed);
  const nHue = S.hct.hue;
  const nC = Math.min(S.hct.chroma, 4);
  let nTone;
  try {
    nTone = t => M.Hct.from(nHue, nC, t).toInt();
    if (typeof nTone(50) !== 'number') throw new Error('bad');
  } catch (e) { nTone = t => cp.n1.tone(t); }
  const nvC = Math.min(S.hct.chroma, 12);
  let nvTone;
  try {
    nvTone = t => M.Hct.from(nHue, nvC, t).toInt();
    if (typeof nvTone(50) !== 'number') throw new Error('bad');
  } catch (e) { nvTone = t => cp.n2.tone(t); }
  S.pal = { cp, a1: cp.a1, a2: cp.a2, a3: cp.a3, n1: { tone: nTone }, nv: { tone: nvTone }, n2: cp.n2, error: cp.error };
}

/* ---------------- 采样 ---------------- */
const samp = document.createElement('canvas');
const sctx = samp.getContext('2d', { willReadFrequently: true });

function coverRect(iw, ih, dw, dh) {
  const ir = iw / ih, dr = dw / dh;
  if (ir > dr) { const sw = ih * dr; return { sx: (iw - sw) / 2, sy: 0, sw, sh: ih }; }
  const sh = iw / dr; return { sx: 0, sy: (ih - sh) / 2, sw: iw, sh };
}

function rebuildSample() {
  samp.width = S.SW; samp.height = S.SH;
  const k = S.SW / Math.max(1, window.innerWidth);
  sctx.clearRect(0, 0, S.SW, S.SH);
  sctx.filter = S.params.blur > 0 ? `blur(${(S.params.blur * k).toFixed(2)}px)` : 'none';
  const r = coverRect(S.bg.width, S.bg.height, S.SW, S.SH);
  sctx.drawImage(S.bg, r.sx, r.sy, r.sw, r.sh, 0, 0, S.SW, S.SH);
  sctx.filter = 'none';
  S.sampleData = sctx.getImageData(0, 0, S.SW, S.SH).data;
}

function sampleRect(rect) {
  const sx = S.SW / Math.max(1, window.innerWidth);
  const sy = S.SH / Math.max(1, window.innerHeight);
  const pad = S.params.blur;
  const x0 = clamp((rect.left - pad) * sx, 0, S.SW - 1);
  const x1 = clamp((rect.right + pad) * sx, 1, S.SW);
  const y0 = clamp((rect.top - pad) * sy, 0, S.SH - 1);
  const y1 = clamp((rect.bottom + pad) * sy, 1, S.SH);
  const d = S.sampleData;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const i = (y * S.SW + x) * 4;
      r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
    }
  }
  if (!n) return { r: 22, g: 18, b: 15 };
  return { r: r / n, g: g / n, b: b / n };
}

/* ---------------- 求解 ---------------- */
function solveBare(B) {
  const bt = M.Hct.fromInt(rgbToArgb(B)).tone;
  const cands = bt > 50 ? [20, 10, 30, 15, 40, 50] : [95, 90, 99, 100, 80, 70];
  let best = null;
  for (const t of cands) {
    const F = argbToRgb(S.pal.n1.tone(t));
    const ratio = contrast(F, B);
    const r = { F, G: null, C: B, alpha: 0, tone: t, ratio, ok: ratio >= TARGET_CR, mode: 'bare', adjusted: false };
    if (r.ok) return r;
    if (!best || ratio > best.ratio) best = r;
  }
  return best;
}

function solveGlass(B, baseAlpha, auto, toneOff) {
  if (baseAlpha < 0.02) return solveBare(B);
  const light = S.activeMode === 'light';
  const a0 = clamp(baseAlpha, 0, 1);
  const bt = M.Hct.fromInt(rgbToArgb(B)).tone;
  const F = argbToRgb(S.pal.n1.tone(light ? 15 : 95));
  const wBg = 1 - a0 * 0.8;
  const wantBg = light ? clamp(Math.round(bt) + 8, 86, 98) : clamp(Math.round(bt) + 8, 14, 34);
  const wantFlat = light ? 92 : 24;
  const tOff = light ? -(toneOff || 0) : (toneOff || 0);
  const want = clamp(Math.round(wantFlat + (wantBg - wantFlat) * wBg) + tOff,
    light ? 78 : 6, light ? 99 : 46);
  const pool = light ? LIGHT_TONES : TONES;
  const order = pool.slice().sort((x, y) => Math.abs(x - want) - Math.abs(y - want));
  const pushTone = light ? 96 : 15;
  for (const t of order) {
    const G = argbToRgb(S.pal.n1.tone(t));
    const C = mix(G, B, a0);
    const ratio = contrast(F, C);
    if (ratio >= TARGET_CR) return { F, G, C, alpha: a0, tone: t, ratio, ok: true, adjusted: false, want, mode: 'glass' };
  }
  if (auto) {
    for (let a = Math.min(a0 + .05, .99); a <= 1.001; a += .05) {
      const G = argbToRgb(S.pal.n1.tone(pushTone));
      const C = mix(G, B, a);
      const ratio = contrast(F, C);
      if (ratio >= TARGET_CR) return { F, G, C, alpha: a, tone: pushTone, ratio, ok: true, adjusted: true, req: a0, want, mode: 'glass' };
    }
    const G = argbToRgb(S.pal.n1.tone(pushTone));
    const C = mix(G, B, 1);
    return { F, G, C, alpha: 1, tone: pushTone, ratio: contrast(F, C), ok: false, adjusted: true, req: a0, want, mode: 'glass' };
  }
  const t0 = order[0];
  const G0 = argbToRgb(S.pal.n1.tone(t0));
  const C0 = mix(G0, B, a0);
  return { F, G: G0, C: C0, alpha: a0, tone: t0, ratio: contrast(F, C0), ok: false, adjusted: false, want, mode: 'glass' };
}

/* ---------------- 目标收集（适配时璃 UI） ---------------- */
function collect() {
  const out = [];
  const rail = document.querySelector('.rail');
  if (rail) out.push({ el: rail, name: '侧栏 · surface.rail', off: S.slots.rail, toff: -6 });
  const tb = document.querySelector('.tabbar');
  if (tb) out.push({ el: tb, name: '标签栏 · surface.nav', off: S.slots.nav, toff: -4 });
  document.querySelectorAll('.card').forEach((el, i) => {
    out.push({ el, name: el.dataset.name || ('模块 ' + (i + 1)), off: S.slots.card, toff: 0 });
  });
  document.querySelectorAll('[data-solve]').forEach(el => {
    const isList = el.dataset.solveKind === 'list';
    out.push({ el, name: el.dataset.solve || '内嵌', off: isList ? S.slots.list : S.slots.input, toff: isList ? 3 : -2 });
  });
  return out;
}

/* ---------------- 应用：求解并写入令牌 ---------------- */
function apply() {
  if (!S.pal || !S.bg) return;
  rebuildSample();
  S.activeMode = resolveMode();
  const light = S.activeMode === 'light';
  const n1 = S.pal.n1, a1 = S.pal.a1;

  const root = document.documentElement.style;
  root.setProperty('--blur', S.params.blur + 'px');
  root.setProperty('--r-sm', (RADIUS_BASE.sm * S.params.radius).toFixed(1) + 'px');
  root.setProperty('--r-md', (RADIUS_BASE.md * S.params.radius).toFixed(1) + 'px');
  root.setProperty('--r-lg', (RADIUS_BASE.lg * S.params.radius).toFixed(1) + 'px');
  root.setProperty('--shadow', SHADOWS[Math.round(S.params.shadow)] || 'none');

  if (light) {
    root.setProperty('--bg', toHex(argbToRgb(n1.tone(99))));
    root.setProperty('--fg', toHex(argbToRgb(n1.tone(12))));
    root.setProperty('--fg2', toHex(argbToRgb(S.pal.nv.tone(35))));
    root.setProperty('--fg3', toHex(argbToRgb(S.pal.nv.tone(46))));
    root.setProperty('--primary', toHex(argbToRgb(a1.tone(40))));
    root.setProperty('--on-primary', toHex(argbToRgb(a1.tone(100))));
    root.setProperty('--pc', toHex(argbToRgb(a1.tone(88))));
    root.setProperty('--on-pc', toHex(argbToRgb(a1.tone(15))));
    root.setProperty('--line', `rgba(0,0,0,${(0.06 + 0.05 * (1 - S.params.alpha)).toFixed(3)})`);
    root.setProperty('--scrim', 'rgba(255,255,255,.10)');
    root.setProperty('--ok', '#0F7A5A');
    root.setProperty('--warn', '#A96300');
    root.setProperty('--bad', '#B3261E');
  } else {
    root.setProperty('--bg', toHex(argbToRgb(n1.tone(8))));
    root.setProperty('--fg', toHex(argbToRgb(n1.tone(95))));
    root.setProperty('--fg2', toHex(argbToRgb(S.pal.nv.tone(82))));
    root.setProperty('--fg3', toHex(argbToRgb(S.pal.nv.tone(60))));
    root.setProperty('--primary', toHex(argbToRgb(a1.tone(80))));
    root.setProperty('--on-primary', toHex(argbToRgb(a1.tone(20))));
    root.setProperty('--pc', toHex(argbToRgb(a1.tone(30))));
    root.setProperty('--on-pc', toHex(argbToRgb(a1.tone(90))));
    root.setProperty('--line', `rgba(255,255,255,${(0.06 + 0.06 * (1 - S.params.alpha)).toFixed(3)})`);
    root.setProperty('--scrim', 'rgba(0,0,0,.12)');
    root.setProperty('--ok', '#5DCAA5');
    root.setProperty('--warn', '#EF9F27');
    root.setProperty('--bad', '#E86A5C');
  }

  document.body.classList.toggle('light', light);
  document.body.classList.toggle('opaque', S.params.alpha >= 0.995);
  document.body.classList.toggle('bare', S.params.blur < 1 || S.params.alpha < .02);

  S.results = [];
  for (const t of collect()) {
    const rect = t.el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const B = sampleRect(rect);
    const res = solveGlass(B, slotAlpha(S.params.alpha, t.off), S.auto, t.toff);
    if (res.mode === 'bare') {
      t.el.style.background = 'transparent';
      t.el.style.borderColor = 'transparent';
      t.el.classList.add('bare-el');
    } else {
      t.el.style.background = rgba(res.G, res.alpha);
      t.el.classList.remove('bare-el');
    }
    t.el.style.color = toHex(res.F);
    t.el.style.setProperty('--fg', toHex(res.F));
    S.results.push({ name: t.name, ...res, B });
  }
  window.dispatchEvent(new CustomEvent('tg-applied', { detail: S.results }));
}

/* ---------------- 壁纸导入 ---------------- */
// 换壁纸后，手动选的主题色来自旧壁纸，会与新壁纸打架 → 清除覆盖，回到采样结果
function resetManualOnWallpaperChange() {
  LAYERS.user.manualSeed = 0;
}
function setWallpaperFromDataUrl(url, cb) {
  const img = new Image();
  img.onload = () => {
    S.img = img;
    S.imgDataUrl = url;
    resetManualOnWallpaperChange();
    drawWallpaper();
    buildPal(extractSeed());
    syncAll();
    saveState();
    if (cb) cb();
  };
  img.src = url;
}

function setBuiltinWallpaper(name) {
  S.img = null; S.imgDataUrl = null; S.wall = name;
  resetManualOnWallpaperChange();
  drawWallpaper();
  buildPal(extractSeed());
  syncAll();
  saveState();
}

/* ---------------- 本地持久化（Electron 下 localStorage 可靠） ---------------- */
const LS_KEY = 'timeglass.theme.v1';
function saveState() {
  try {
    const u = LAYERS.user;
    localStorage.setItem(LS_KEY, JSON.stringify({
      v: 1,
      params: u.params || {}, slots: u.slots || {},
      mode: u.mode || null, seedMode: u.seedMode || null,
      manualSeed: u.manualSeed || 0,
      order: LAYER_ORDER.slice(),
      enabled: { app: LAYERS.app.enabled !== false, base: true },
      wall: S.img ? null : S.wall,
      img: S.imgDataUrl || null,
      auto: S.auto
    }));
  } catch (e) { /* 存储失败不致命 */ }
}
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    if (!d || d.v !== 1) return false;
    if (d.params) LAYERS.user.params = d.params;
    if (d.slots) LAYERS.user.slots = d.slots;
    if (d.mode) LAYERS.user.mode = d.mode;
    if (d.seedMode) LAYERS.user.seedMode = d.seedMode;
    if (d.manualSeed) LAYERS.user.manualSeed = d.manualSeed;
    if (d.auto === false) S.auto = false;
    if (d.wall) S.wall = d.wall;
    if (d.img) { S.imgDataUrl = d.img; return 'img'; }
  } catch (e) { /* ignore */ }
  return true;
}

/* ---------------- 对外接口 ---------------- */
window.TimeglassEngine = {
  S, LAYERS, LAYER_ORDER, WALLS, TARGET_CR,
  clamp, contrast, mix, rgba, toHex, hexToRgb,
  slotAlpha, drawWallpaper, avgWallTone, resolveMode,
  extractSeed, pickCandidates, ringSeed, buildPal,
  solveGlass, solveBare, collect, apply, syncAll,
  setUser, clearUser, resolveLayers,
  setWallpaperFromDataUrl, setBuiltinWallpaper,
  saveState, loadState,
  reseed() { buildPal(extractSeed()); syncAll(); },
  // 采样方式（整体色调/主色簇）：切换后重置手动覆盖，回到自动采样结果
  setSampleMode(mode) {
    LAYERS.user.seedMode = mode;
    LAYERS.user.manualSeed = 0;
    S.seedMode = mode;   // 先同步状态，再取种子（否则 extractSeed 用旧状态）
    S.manualSeed = 0;
    buildPal(extractSeed());
    syncAll();
    saveState();
  },
  // 手动选主题色：设覆盖种子，不改变采样方式
  setThemeSeed(seed) {
    LAYERS.user.manualSeed = seed;
    S.manualSeed = seed; // 先同步，再 buildPal（手动覆盖直接就是主题色）
    buildPal(seed);
    syncAll();
    saveState();
  },
  init() {
    const st = loadState();
    drawWallpaper();
    // 关键：先把皮肤层合并进 S（seedMode/manualSeed/mode/params/slots），
    // 再取种子——否则重启后手动种子与取色策略会被默认 ring 覆盖。
    // 此时 S.pal 尚未建立，apply() 会因 !S.pal 直接空转返回，安全。
    syncAll();
    if (st === 'img' && S.imgDataUrl) {
      const img = new Image();
      img.onload = () => { S.img = img; drawWallpaper(); buildPal(extractSeed()); syncAll(); };
      img.src = S.imgDataUrl;
    } else {
      buildPal(extractSeed());
      syncAll();
    }
  }
};
})();
