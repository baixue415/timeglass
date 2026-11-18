/* 时璃 · 设置与元数据持久化（JSON 文件，存于 userData） */
'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DIR = () => {
  const d = path.join(app.getPath('userData'), 'data');
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  return d;
};
const SETTINGS_FILE = () => path.join(DIR(), 'settings.json');
const META_FILE = () => path.join(DIR(), 'meta.json');

const DEFAULT_SETTINGS = {
  capture: {
    enabled: true,
    intervalMin: 5,                  // 采集间隔（分钟）
    rangeStart: '09:00',             // 采集范围开始
    rangeEnd: '18:00',               // 采集范围结束
    allDay: false,                   // 全天采集（忽略 rangeStart/rangeEnd）
    dedupe: true,                    // 相邻截图完全一致时跳过
    writeTimestampMeta: true,        // 时间戳写入元数据
    writeWindowMeta: true,           // 窗口戳（应用名+标题）写入元数据
    pauseOnLock: true,               // 锁屏暂停
    pauseOnFullscreen: false,        // 全屏应用暂停
    pauseOnIdle: false,              // 键鼠长期不活跃时暂停
    idleMinutes: 15,                 // 空闲判定阈值（分钟）
    excludeApps: []                  // 排除的应用（前台进程名命中则跳过）
  },
  storage: {
    dir: path.join(app.getPath('pictures'), 'Timeglass'), // 截图存储根目录
    keepDays: 90,                   // 保留天数（0=永久）
    maxGB: 5                         // 空间上限
  },
  app: {
    autostart: false,               // 开机自启（静默到托盘）
    silentToTray: false,            // 启动时静默到托盘
    minimizeToTray: true,           // 关闭按钮最小化到托盘
    hotkey: 'Control+Alt+P'        // 暂停/恢复热键
  }
};

let settings = null;
let meta = null;

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('readJson failed', file, e.message);
    return fallback;
  }
}
function writeJson(file, obj) {
  try {
    fs.writeFileSync(file, JSON.stringify(obj, null, 2), 'utf8');
  } catch (e) { console.warn('writeJson failed', file, e.message); }
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!over || typeof over !== 'object') return out;
  for (const k of Object.keys(over)) {
    const bv = base ? base[k] : undefined;
    const ov = over[k];
    if (bv && typeof bv === 'object' && !Array.isArray(bv) && ov && typeof ov === 'object' && !Array.isArray(ov)) {
      out[k] = deepMerge(bv, ov);
    } else if (ov !== undefined) {
      out[k] = ov;
    }
  }
  return out;
}

module.exports = {
  getSettings() {
    if (!settings) settings = deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE(), {}));
    return settings;
  },
  saveSettings(patch) {
    const cur = this.getSettings();
    settings = deepMerge(cur, patch || {});
    writeJson(SETTINGS_FILE(), settings);
    return settings;
  },
  resetSettings() {
    settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
    writeJson(SETTINGS_FILE(), settings);
    return settings;
  },
  DEFAULT_SETTINGS,

  /* ---- 元数据（截图索引） ---- */
  getMeta() {
    if (!meta) {
      meta = readJson(META_FILE(), { shots: [] });
      if (!Array.isArray(meta.shots)) meta = { shots: [] };
    }
    return meta;
  },
  addShot(rec) {
    const m = this.getMeta();
    m.shots.push(rec);
    // 元数据破万时截断最旧的（防 JSON 无限膨胀；文件本身仍受保留策略清理）
    if (m.shots.length > 20000) m.shots = m.shots.slice(-15000);
    writeJson(META_FILE(), m);
  },
  removeShot(id) {
    const m = this.getMeta();
    m.shots = m.shots.filter(s => s.id !== id);
    writeJson(META_FILE(), m);
  },
  saveMeta(m) { writeJson(META_FILE(), m); },
  shots() { return this.getMeta().shots; },

  /* ---- 派生统计 ---- */
  stats() {
    const s = this.shots();
    const now = Date.now();
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const byDay = {};
    const byApp = {};
    let todayCount = 0, weekCount = 0;
    for (const sh of s) {
      // 用本地日期做 key（不能用 toISOString——那是 UTC，东八区会整体回退一天，与前端 dayKey 对不上）
      const d = new Date(sh.ts);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      byDay[key] = (byDay[key] || 0) + 1;
      if (sh.ts >= today.getTime()) todayCount++;
      if (now - sh.ts < 7 * 864e5) weekCount++;
      if (sh.app) byApp[sh.app] = (byApp[sh.app] || 0) + 1;
    }
    return { total: s.length, todayCount, weekCount, byDay, byApp };
  }
};
