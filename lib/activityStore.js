/* 时璃 · 键鼠活跃度持久化（按天分文件，独立于截图元数据）
   目录：<userData>/data/activity/YYYY-MM-DD.json
   结构：{ "HH:MM": { k: 按键次数, c: 点击次数, m: 移动像素 } } */
'use strict';
const { app } = require('electron');
const path = require('path');
const fs = require('fs');

function dir() { return path.join(app.getPath('userData'), 'data', 'activity'); }
function fileFor(day) { return path.join(dir(), day + '.json'); }

function readJson(f, def) {
  try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return def; }
}
function writeJson(f, obj) {
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, f);
  } catch (e) { console.warn('[activity] save failed', e.message); }
}

/* 追加一批（按天分组）：{ "YYYY-MM-DD": { "HH:MM": {k,c,m} } } */
function append(byDay) {
  if (!byDay) return;
  for (const [day, minutes] of Object.entries(byDay)) {
    if (!minutes || !Object.keys(minutes).length) continue;
    const f = fileFor(day);
    const data = readJson(f, {});
    for (const [mm, v] of Object.entries(minutes)) {
      const cur = data[mm] || { k: 0, c: 0, m: 0 };
      cur.k += v.k || 0;
      cur.c += v.c || 0;
      cur.m += v.m || 0;
      data[mm] = cur;
    }
    writeJson(f, data);
  }
}

/* 读取某一天：{ "HH:MM": {k,c,m} } */
function getDay(day) {
  return readJson(fileFor(day), {});
}

/* 月度汇总：{ "2026-11-01": {k,c,m}, ... }（供日历热力） */
function monthSummary(month) {
  const out = {};
  let files;
  try { files = fs.readdirSync(dir()); } catch (e) { return out; }
  for (const f of files) {
    if (!f.startsWith(month + '-') || !f.endsWith('.json')) continue;
    const day = f.slice(0, 10);
    const data = readJson(path.join(dir(), f), {});
    let k = 0, c = 0, m = 0;
    for (const v of Object.values(data)) { k += v.k || 0; c += v.c || 0; m += v.m || 0; }
    out[day] = { k, c, m };
  }
  return out;
}

/* 清理超过 keepDays 天的旧文件 */
function cleanup(keepDays) {
  if (!keepDays || keepDays <= 0) return;
  let files;
  try { files = fs.readdirSync(dir()); } catch (e) { return; }
  const cutoff = Date.now() - keepDays * 86400000;
  for (const f of files) {
    if (!/^\d{4}-\d{2}-\d{2}\.json$/.test(f)) continue;
    const ts = new Date(f.slice(0, 10) + 'T00:00:00').getTime();
    if (ts < cutoff) { try { fs.unlinkSync(path.join(dir(), f)); } catch (e) { /* ignore */ } }
  }
}

module.exports = { append, getDay, monthSummary, cleanup, fileFor, dir };
