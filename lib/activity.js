/* 时璃 · 键鼠活跃度采集（全局钩子精确统计）
   用 uiohook-napi 监听系统级键盘/鼠标事件，按分钟聚合：
     k = 键盘按键次数，c = 鼠标点击次数，m = 鼠标移动像素。
   按天分组暂存，drain() 取出交给 activityStore 落盘。 */
'use strict';
const { uIOhook } = require('uiohook-napi');

let running = false;
let lastX = null, lastY = null;
let curDay = null, curMin = null, bucket = null; // 当前分钟累加桶 { k, c, m }
let pendingByDay = {}; // { "YYYY-MM-DD": { "HH:MM": { k, c, m } } }

const pad = n => String(n).padStart(2, '0');
const dayKey = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const minKey = d => pad(d.getHours()) + ':' + pad(d.getMinutes());

// 跨分钟/跨天时把当前桶归档，并开新桶
function roll() {
  const now = new Date();
  const day = dayKey(now), min = minKey(now);
  if (day !== curDay || min !== curMin) {
    flushBucket();
    curDay = day; curMin = min; bucket = { k: 0, c: 0, m: 0 };
  }
}

function flushBucket() {
  if (!bucket || !curDay) return;
  const d = pendingByDay[curDay] || (pendingByDay[curDay] = {});
  const c = d[curMin] || (d[curMin] = { k: 0, c: 0, m: 0 });
  c.k += bucket.k; c.c += bucket.c; c.m += bucket.m;
  bucket = null;
}

// 按键去重：长按会连续触发 keydown（系统键盘重复），用 pressed 集合只记首次按下
const pressed = new Set();
function onKeyDown(e) {
  roll();
  const code = e && e.keycode;
  if (code != null) { if (pressed.has(code)) return; pressed.add(code); }
  bucket.k++;
}
function onKeyUp(e) { if (e && e.keycode != null) pressed.delete(e.keycode); }
function onClick() { roll(); bucket.c++; }
function onMove(e) {
  roll();
  if (lastX != null) {
    const dx = e.x - lastX, dy = e.y - lastY;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 0) bucket.m += d;
  }
  lastX = e.x; lastY = e.y;
}

function start() {
  if (running) return;
  roll();
  uIOhook.on('keydown', onKeyDown);
  uIOhook.on('keyup', onKeyUp);
  uIOhook.on('click', onClick);
  uIOhook.on('mousemove', onMove);
  uIOhook.start();
  running = true;
}

function stop() {
  if (running) {
    try { uIOhook.stop(); } catch (e) { /* ignore */ }
    running = false;
  }
  flushBucket(); // 把最后一分钟的数据归档
}

// 取出待落盘数据并清空：{ "YYYY-MM-DD": { "HH:MM": {k,c,m} } }
function drain() {
  const out = pendingByDay;
  pendingByDay = {};
  return out;
}

// 实时快照：内存里尚未落盘的数据（当前桶 + pending），供界面实时跳变
function snapshot() {
  const out = {};
  const add = (day, mm, v) => {
    const d = out[day] || (out[day] = {});
    const c = d[mm] || (d[mm] = { k: 0, c: 0, m: 0 });
    c.k += v.k || 0; c.c += v.c || 0; c.m += v.m || 0;
  };
  if (bucket && curDay && curMin) add(curDay, curMin, bucket);
  for (const [day, mins] of Object.entries(pendingByDay)) {
    for (const [mm, v] of Object.entries(mins)) add(day, mm, v);
  }
  return out; // { "YYYY-MM-DD": { "HH:MM": {k,c,m} } }
}

module.exports = { start, stop, drain, snapshot };
