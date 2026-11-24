/* ============================================================
   时璃 Timeglass · 渲染层主逻辑
   五视图：时间轴 / 归档 / 转码工坊 / 偏好设置 / 外观与皮肤
   全部颜色吃 engine.js 下发的令牌；面板背景由引擎求解内联。
   ============================================================ */
(() => {
'use strict';
const E = window.TimeglassEngine;
const api = window.api;
const $ = s => document.querySelector(s);

/* ---------------- 小工具 ---------------- */
let toastTimer = null;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2400);
}
const fmtTime = ts => {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const fmtDT = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${fmtTime(ts)}:${String(d.getSeconds()).padStart(2, '0')}`;
};
const fmtSize = n => n > 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
const dayKey = ts => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* 缩略图缓存：file -> dataURL（LRU，上限 400 张 ≈ 16MB 字符串） */
const imgCache = new Map();
const CACHE_MAX = 400;
async function thumbOf(file, maxW = 360) {
  if (imgCache.has(file)) {
    const u = imgCache.get(file);
    imgCache.delete(file); imgCache.set(file, u); // 命中移到队尾
    return u;
  }
  const url = await api.meta.thumb({ file, maxW });
  if (url) {
    imgCache.set(file, url);
    if (imgCache.size > CACHE_MAX) imgCache.delete(imgCache.keys().next().value);
  }
  return url;
}

/* ---------------- 全局状态 ---------------- */
let settings = null;
let stats = null;
let captureStatus = null;
let curDay = dayKey(Date.now());
let calMonth = new Date(); calMonth.setDate(1);
let archFilter = { q: '', app: '', day: null, range: 'all', groupBy: 'day', sort: 'desc', selectMode: false, selected: new Set() };
const collapsedGroups = new Set(); // 图库折叠的分组 key
let hourSel = new Set();   // 热力条选中的小时
let hourAnchor = null;     // Shift 区间选择的锚点
let liveTimer = null;      // 实时数字刷新定时器
let ffmpegOk = null;

const CRUMBS = {
  timeline: ['时间轴', '按小时浏览今天的采集记录'],
  archive: ['归档图库', '全部截图 · 元数据检索'],
  transcode: ['转码工坊', '图形化 FFmpeg 压缩'],
  settings: ['偏好设置', '采集 / 存储 / 托盘 / 隐私'],
  appearance: ['外观与皮肤', '壁纸取色 · 材质 · 皮肤包']
};

/* ---------------- 视图切换 ---------------- */
async function goto(view) {
  document.querySelectorAll('.rail .rbtn').forEach(b => b.classList.toggle('on', b.dataset.view === view));
  // 切走即卸载：隐藏视图的 DOM 与解码位图不常驻内存。
  // 回切时 goto 本来就会重渲染（状态都在全局变量里），所以清空是零成本优化。
  document.querySelectorAll('.view').forEach(v => {
    const on = v.id === 'view-' + view;
    v.classList.toggle('on', on);
    if (!on) v.innerHTML = '';
  });
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; } // 离开时间轴不再空转实时计时器
  $('#detail').classList.remove('on'); // 切视图时收起详情面板
  $('#crumb').textContent = CRUMBS[view][0];
  $('#crumb-sub').textContent = CRUMBS[view][1];
  const fn = { timeline: renderTimeline, archive: renderArchive, transcode: renderTranscode, settings: renderSettings, appearance: renderAppearance }[view];
  await fn();          // 等视图 DOM 填充完成
  E.apply();           // 再求解玻璃色，否则新面板拿不到背景采样
}

/* ============================================================
   01 · 时间轴
   ============================================================ */
async function renderTimeline() {
  if (liveTimer) { clearInterval(liveTimer); liveTimer = null; }
  const view = $('#view-timeline');
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const monthKey = `${y}-${String(m + 1).padStart(2, '0')}`;
  const actMonth = await api.activity.month(monthKey);
  const actDay = await api.activity.day(curDay);
  const dayStart = new Date(curDay + 'T00:00:00').getTime();
  const dayShots = await api.meta.list({ fromTs: dayStart, toTs: dayStart + 86400000, limit: 300 });

  const cal = buildCalendar(actMonth);
  const detail = buildDayDetail(actDay, curDay);
  const shotsHtml = buildDayShots(dayShots);
  // 应用分布：按选中日期当天的截图统计（随日历选中日变化）
  const dayApps = {};
  for (const s of dayShots) if (s.app) dayApps[s.app] = (dayApps[s.app] || 0) + 1;
  const topApps = Object.entries(dayApps).sort((a, b) => b[1] - a[1]).slice(0, 4);
  const maxApp = topApps.length ? topApps[0][1] : 1;

  view.innerHTML = `
  <div class="grid2">
    <div>
      <div class="card" data-name="活跃度日历">
        <div class="calhead">
          <b>${y} 年 ${m + 1} 月</b>
          <span class="nav"><button id="cal-prev">‹</button><button id="cal-today">今</button><button id="cal-next">›</button></span>
        </div>
        <div class="cal">${cal.html}</div>
        <div class="callegend"><span>活跃度</span><i class="h0"></i><i class="h1"></i><i class="h2"></i><i class="h3"></i><i class="h4"></i><span>低→高</span></div>
      </div>
      <div class="card" data-name="应用分布">
        <h3>当天应用分布</h3>
        <div class="hint">选中日期的截图按前台应用统计</div>
        ${topApps.length ? topApps.map(([app, n]) => `
          <div class="appbar">
            <div class="top"><span class="n">${esc(app)}</span><b>${n} 张</b></div>
            <div class="bar"><i style="width:${Math.max(4, n / maxApp * 100)}%"></i></div>
          </div>`).join('') : '<div class="empty">这天没有截图，或未记录窗口应用</div>'}
      </div>
    </div>
    <div>
      <div class="card" data-name="日详情">${detail}</div>
      <div class="card" data-name="当天截图">${shotsHtml}</div>
    </div>
  </div>`;

  // 日详情截图懒加载
  view.querySelectorAll('.daythumbs .thumb').forEach((el, i) => {
    const s = dayShots[i];
    if (!s) return;
    el.onclick = () => openDetail(s);
    thumbOf(s.file).then(u => { if (u) { const img = el.querySelector('img'); if (img) img.src = u; } });
  });

  // 「查看当天全部」→ 带日期筛选跳图库
  const moreBtn = view.querySelector('#day-more');
  if (moreBtn) moreBtn.onclick = () => {
    archFilter = { q: '', app: '', day: curDay, range: 'all', groupBy: 'day', sort: 'desc', selectMode: false, selected: new Set() };
    goto('archive');
  };

  view.querySelector('#cal-prev').onclick = async () => { calMonth.setMonth(calMonth.getMonth() - 1); await renderTimeline(); E.apply(); };
  view.querySelector('#cal-next').onclick = async () => { calMonth.setMonth(calMonth.getMonth() + 1); await renderTimeline(); E.apply(); };
  view.querySelector('#cal-today').onclick = async () => { calMonth = new Date(); calMonth.setDate(1); curDay = dayKey(Date.now()); await renderTimeline(); E.apply(); };
  view.querySelectorAll('.cal .cell[data-day]').forEach(c => c.onclick = async () => {
    curDay = c.dataset.day;
    await renderTimeline();
    E.apply();
  });

  // 小时格区间选择 + 实时数字跳变
  bindHourSelect(view, actDay);
  startLiveStats(actDay, curDay);
}

function activityScore(v) { return (v.k || 0) + (v.c || 0) + (v.m || 0) / 100; }

function buildCalendar(actMonth) {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const first = new Date(y, m, 1);
  const start = (first.getDay() + 6) % 7; // 周一开头
  const days = new Date(y, m + 1, 0).getDate();
  const byDay = stats?.byDay || {};
  const todayK = dayKey(Date.now());
  const scores = Object.values(actMonth || {}).map(activityScore);
  const maxScore = Math.max(1, ...scores);
  let html = '一二三四五六日'.split('').map(d => `<span class="dow">${d}</span>`).join('');
  for (let i = 0; i < start; i++) html += '<span class="cell dim"></span>';
  for (let d = 1; d <= days; d++) {
    const k = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const n = byDay[k] || 0;
    const av = actMonth ? actMonth[k] : null;
    const score = av ? activityScore(av) : 0;
    const lv = score > 0 ? Math.min(4, Math.max(1, Math.ceil(score / maxScore * 4))) : 0;
    html += `<span class="cell heat-${lv} ${k === todayK ? 'today' : ''} ${k === curDay ? 'sel' : ''}" data-day="${k}">${d}${n ? `<span class="cnt">${n}</span>` : ''}</span>`;
  }
  return { html };
}

function buildDayDetail(actDay, day) {
  const d = new Date(day + 'T00:00:00');
  const wd = '日一二三四五六'[d.getDay()];
  const hours = Array(24).fill(0);
  let K = 0, C = 0, M = 0;
  for (const [mm, v] of Object.entries(actDay || {})) {
    const h = parseInt(mm.slice(0, 2), 10);
    if (h >= 0 && h < 24) hours[h] += activityScore(v);
    K += v.k || 0; C += v.c || 0; M += v.m || 0;
  }
  const maxH = Math.max(1, ...hours);
  const heat = hours.map((s, i) => `<span class="hhb" data-hour="${i}" title="${i}时" style="opacity:${s > 0 ? (0.15 + (s / maxH) * 0.85) : 0.06}"></span>`).join('');
  const total = Math.round(K + C + M / 100);
  return `<div class="ddhead"><h3>${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${wd}</h3><span class="ddscore" id="dd-total">活跃度 ${total}</span></div>
    <div class="hint">当天的键鼠活跃度节奏 · 点小时格看区间累加（Shift 连选 / Ctrl 多选）</div>
    <div class="hourheat" id="hourheat">${heat}</div>
    <div class="hourlabs"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>
    <div class="hourselinfo" id="hourselinfo"></div>
    <div class="statrow" style="margin-top:14px">
      <div class="stat"><b id="dd-k">${K}</b><span>键盘</span></div>
      <div class="stat"><b id="dd-c">${C}</b><span>点击</span></div>
      <div class="stat"><b id="dd-m">${Math.round(M).toLocaleString()}</b><span>移动 px</span></div>
    </div>`;
}

function buildDayShots(dayShots) {
  if (!dayShots.length) return `<h3>当天截图</h3><div class="empty" style="margin-top:10px">这天没有截图</div>`;
  const PREVIEW = 6;
  const preview = dayShots.slice(0, PREVIEW);
  const thumbs = preview.map(s => `<div class="thumb"><img alt=""><span class="t">${fmtTime(s.ts)}</span></div>`).join('');
  const more = dayShots.length > PREVIEW ? `<button class="btn morebtn" id="day-more">查看全部 ${dayShots.length} 张 →</button>` : '';
  return `<div class="dhrow" style="margin:0"><h3 style="margin:0">当天截图 <span class="dhcount">${dayShots.length} 张</span></h3>${more}</div>
    <div class="daythumbs thumbs" style="margin-top:12px">${thumbs}</div>`;
}

/* 小时格区间选择：单击单选 / Shift 连选 / Ctrl 多选 */
function bindHourSelect(view, actDay) {
  view.querySelectorAll('.hourheat .hhb').forEach(el => {
    el.onclick = (e) => {
      const h = +el.dataset.hour;
      if (e.shiftKey && hourAnchor != null) {
        const a = Math.min(hourAnchor, h), b = Math.max(hourAnchor, h);
        hourSel.clear();
        for (let i = a; i <= b; i++) hourSel.add(i);
      } else if (e.ctrlKey || e.metaKey) {
        hourSel.has(h) ? hourSel.delete(h) : hourSel.add(h);
        hourAnchor = h;
      } else {
        // 单击：点已选中的 → 取消该个；否则单选（清空后选中）
        if (hourSel.has(h)) hourSel.delete(h);
        else { hourSel.clear(); hourSel.add(h); }
        hourAnchor = h;
      }
      refreshHourSel(actDay);
    };
  });
  refreshHourSel(actDay);
}

function refreshHourSel(actDay) {
  document.querySelectorAll('.hourheat .hhb').forEach(el => {
    el.classList.toggle('sel', hourSel.has(+el.dataset.hour));
  });
  const info = $('#hourselinfo');
  if (!info) return;
  if (!hourSel.size) { info.textContent = ''; return; }
  let K = 0, C = 0, M = 0;
  for (const [mm, v] of Object.entries(actDay || {})) {
    const h = parseInt(mm.slice(0, 2), 10);
    if (hourSel.has(h)) { K += v.k || 0; C += v.c || 0; M += v.m || 0; }
  }
  const hrs = [...hourSel].sort((a, b) => a - b);
  const range = hrs.length === 1 ? `${hrs[0]} 时` : `${hrs[0]}–${hrs[hrs.length - 1]} 时`;
  const hasNow = hrs.includes(new Date().getHours());
  info.innerHTML = `已选 ${hrs.length} 小时（${range}）· 键盘 <b>${K}</b> · 点击 <b>${C}</b> · 移动 <b>${Math.round(M).toLocaleString()}</b>${hasNow ? ' <span class="nowtag">进行中</span>' : ''}`;
}

/* 实时数字跳变：仅当天，每 2 秒拉一次含内存数据的实时值 */
function startLiveStats(actDay, day) {
  if (day !== dayKey(Date.now())) return;
  liveTimer = setInterval(async () => {
    const view = $('#view-timeline');
    if (!view || !view.classList.contains('on')) return;
    try {
      const data = await api.activity.today();
      let K = 0, C = 0, M = 0;
      for (const v of Object.values(data || {})) { K += v.k || 0; C += v.c || 0; M += v.m || 0; }
      bumpStat('#dd-k', K);
      bumpStat('#dd-c', C);
      bumpStat('#dd-m', Math.round(M).toLocaleString());
      if (hourSel.size) refreshHourSel(data);
    } catch (e) { /* ignore */ }
  }, 2000);
}

function bumpStat(sel, val) {
  const el = document.querySelector(sel);
  if (!el) return;
  const s = String(val);
  if (el.textContent === s) return;
  el.textContent = s;
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
}

/* ============================================================
   02 · 归档
   ============================================================ */
async function renderArchive() {
  const view = $('#view-archive');
  const q = {};
  if (archFilter.q) q.title = archFilter.q;
  if (archFilter.app) q.app = archFilter.app;
  let shots = await api.meta.list({ ...q, limit: 500 });
  shots = filterByRange(shots, archFilter.range);
  if (archFilter.day) shots = shots.filter(s => dayKey(s.ts) === archFilter.day);
  shots.sort((a, b) => archFilter.sort === 'desc' ? b.ts - a.ts : a.ts - b.ts);
  const groups = groupShots(shots, archFilter.groupBy);
  const apps = Object.keys(stats?.byApp || {}).sort();

  view.innerHTML = `
  <div class="card" data-name="检索">
    <div class="filters">
      <input class="input" id="f-q" placeholder="按窗口标题搜索…" style="flex:1;min-width:160px" value="${esc(archFilter.q)}">
      <select class="input" id="f-app" style="width:130px">
        <option value="">全部应用</option>
        ${apps.map(a => `<option value="${esc(a)}" ${archFilter.app === a ? 'selected' : ''}>${esc(a)}</option>`).join('')}
      </select>
      <select class="input" id="f-range" style="width:104px">
        ${[['all', '全部'], ['today', '今天'], ['week', '本周'], ['month', '本月']].map(([v, l]) => `<option value="${v}" ${archFilter.range === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <span class="seg" id="seg-group">
        <button data-v="day" class="${archFilter.groupBy === 'day' ? 'on' : ''}">按天</button>
        <button data-v="month" class="${archFilter.groupBy === 'month' ? 'on' : ''}">按月</button>
      </span>
      <button class="btn" id="f-sort">${archFilter.sort === 'desc' ? '新→旧' : '旧→新'}</button>
      <button class="btn ${archFilter.selectMode ? 'pri' : ''}" id="f-select">${archFilter.selectMode ? '完成' : '多选'}</button>
      <button class="btn" id="f-clear">清除</button>
      ${archFilter.day ? `<span class="statuschip">${archFilter.day} <button id="f-back-cal" title="回到日历视图">← 回日历</button> <button id="f-unday" title="清除日期筛选">✕</button></span>` : ''}
    </div>
    ${shots.length ? `<div class="archgroups" id="archgroups"></div>` : '<div class="empty">没有匹配的截图</div>'}
    ${archFilter.selectMode ? `<div class="batchbar">已选 <b>${archFilter.selected.size}</b> 张 <button class="btn danger" id="batch-del">删除选中</button></div>` : ''}
  </div>`;

  const box = view.querySelector('#archgroups');
  if (box) {
    for (const [key, list] of groups) {
      const collapsed = collapsedGroups.has(key);
      const sec = document.createElement('div');
      sec.className = 'archgroup';
      const head = document.createElement('div');
      head.className = 'ghead';
      head.innerHTML = `<span class="gcaret">${collapsed ? '▸' : '▾'}</span><b>${groupLabel(key, archFilter.groupBy)}</b><span class="gcount">${list.length} 张</span>`;
      head.onclick = () => { collapsedGroups.has(key) ? collapsedGroups.delete(key) : collapsedGroups.add(key); renderArchive(); };
      sec.appendChild(head);
      const grid = document.createElement('div');
      grid.className = 'archgrid ggrid';
      grid.style.display = collapsed ? 'none' : 'grid';
      for (const s of list) {
        const d = document.createElement('div');
        const sel = archFilter.selected.has(s.id);
        d.className = 'archcard' + (sel ? ' selected' : '');
        d.innerHTML = `<img alt=""><div class="m"><span class="app">${esc(s.app || '·')}</span><span>${dayKey(s.ts).slice(5)} ${fmtTime(s.ts)}</span></div>${archFilter.selectMode ? '<span class="pick"></span>' : ''}`;
        grid.appendChild(d);
        thumbOf(s.file).then(url => { if (url) { const im = d.querySelector('img'); if (im) im.src = url; } });
        d.onclick = () => {
          if (archFilter.selectMode) {
            archFilter.selected.has(s.id) ? archFilter.selected.delete(s.id) : archFilter.selected.add(s.id);
            renderArchive();
          } else {
            openDetail(s);
          }
        };
      }
      sec.appendChild(grid);
      box.appendChild(sec);
    }
  }

  view.querySelector('#f-q').oninput = e => { archFilter.q = e.target.value; debounceRender(); };
  view.querySelector('#f-app').onchange = e => { archFilter.app = e.target.value; renderArchive(); };
  view.querySelector('#f-range').onchange = e => { archFilter.range = e.target.value; renderArchive(); };
  view.querySelectorAll('#seg-group button').forEach(b => b.onclick = () => { archFilter.groupBy = b.dataset.v; renderArchive(); });
  view.querySelector('#f-sort').onclick = () => { archFilter.sort = archFilter.sort === 'desc' ? 'asc' : 'desc'; renderArchive(); };
  view.querySelector('#f-select').onclick = () => { archFilter.selectMode = !archFilter.selectMode; archFilter.selected.clear(); renderArchive(); };
  view.querySelector('#f-clear').onclick = () => {
    archFilter = { q: '', app: '', day: null, range: 'all', groupBy: 'day', sort: 'desc', selectMode: false, selected: new Set() };
    renderArchive();
  };
  const unday = view.querySelector('#f-unday');
  if (unday) unday.onclick = () => { archFilter.day = null; renderArchive(); };
  const backCal = view.querySelector('#f-back-cal');
  if (backCal) backCal.onclick = () => {
    curDay = archFilter.day;
    calMonth = new Date(archFilter.day + 'T00:00:00');
    calMonth.setDate(1);
    goto('timeline');
  };
  const batchDel = view.querySelector('#batch-del');
  if (batchDel) batchDel.onclick = async () => {
    const ids = [...archFilter.selected];
    if (!ids.length) return;
    if (!confirm(`确认删除选中的 ${ids.length} 张截图？此操作不可撤销。`)) return;
    for (const id of ids) { try { await api.meta.remove(id); } catch (e) {} }
    archFilter.selected.clear();
    archFilter.selectMode = false;
    toast(`已删除 ${ids.length} 张截图`);
    refreshStats();
    await renderArchive();
    E.apply();
  };
  E.apply(); // 重渲染后重新求解玻璃材质，否则图库卡片会透明
}

function filterByRange(shots, range) {
  if (range === 'all') return shots;
  const now = new Date();
  const startDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  if (range === 'today') return shots.filter(s => s.ts >= startDay);
  if (range === 'week') { const dow = (now.getDay() + 6) % 7; return shots.filter(s => s.ts >= startDay - dow * 86400000); }
  if (range === 'month') { return shots.filter(s => s.ts >= new Date(now.getFullYear(), now.getMonth(), 1).getTime()); }
  return shots;
}

function groupShots(shots, groupBy) {
  const map = new Map();
  for (const s of shots) {
    const key = groupBy === 'month' ? dayKey(s.ts).slice(0, 7) : dayKey(s.ts);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(s);
  }
  return [...map.entries()];
}

function groupLabel(key, groupBy) {
  if (groupBy === 'month') { const parts = key.split('-'); return `${parts[0]} 年 ${+parts[1]} 月`; }
  const d = new Date(key + 'T00:00:00');
  const wd = '日一二三四五六'[d.getDay()];
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 · 周${wd}`;
}
let debTimer = null;
function debounceRender() {
  clearTimeout(debTimer);
  debTimer = setTimeout(async () => { await renderArchive(); E.apply(); }, 350);
}

/* 详情面板 */
async function openDetail(s) {
  const url = await api.meta.image(s.file); // 详情要高清原图，直读不进缩略图缓存
  const tags = [];
  if (s.app) tags.push(s.app);
  const d = $('#detail');
  d.innerHTML = `
    <img class="hero" src="${url || ''}" alt="">
    <h3 style="margin-bottom:8px">${fmtDT(s.ts)}</h3>
    <div class="kv"><span class="k">窗口应用</span><span class="v">${esc(s.app || '未记录')}</span></div>
    <div class="kv"><span class="k">窗口标题</span><span class="v">${esc(s.title || '未记录')}</span></div>
    <div class="kv"><span class="k">尺寸</span><span class="v">${s.w} × ${s.h}</span></div>
    <div class="kv"><span class="k">大小</span><span class="v">${fmtSize(s.size || 0)}</span></div>
    <div class="kv"><span class="k">文件</span><span class="v" style="font-family:Consolas,monospace;font-size:11px">${esc(s.file)}</span></div>
    <div class="hint" style="margin-top:10px;color:var(--fg3);font-size:11px">时间戳与窗口戳只写入元数据，画面本身不加任何水印</div>
    <div class="tagrow">${tags.map(t => `<span class="tag">${esc(t)}</span>`).join('')}</div>
    <div class="btnrow">
      <button class="btn" id="d-open">打开图片</button>
      <button class="btn" id="d-folder">所在文件夹</button>
      <button class="btn danger" id="d-del">删除</button>
    </div>`;
  d.classList.add('on');
  // 详情面板是玻璃材质，等滑入过渡(250ms)结束后再求解背景，否则会采样到屏幕外
  setTimeout(() => E.apply(), 280);
  $('#d-open').onclick = () => api.shell.openPath(s.file);
  $('#d-folder').onclick = () => api.shell.showInFolder(s.file);
  $('#d-del').onclick = async () => {
    await api.meta.remove(s.id);
    imgCache.delete(s.file);
    d.classList.remove('on');
    toast('已删除截图与元数据');
    refreshStats(); await renderArchive(); E.apply();
  };
}
document.addEventListener('click', e => {
  const d = $('#detail');
  if (d.classList.contains('on') && !d.contains(e.target) && !e.target.closest('.archcard') && !e.target.closest('.thumb')) {
    d.classList.remove('on');
  }
});

/* ============================================================
   03 · 转码工坊
   ============================================================ */
const tc = {
  input: null, probe: null,
  container: 'mp4', vcodec: 'libx264', nvenc: false,
  mode: 'bitrate', bitrate: 2500, maxrate: 3, bufsize: 6, crf: 23,
  fpsSeg: '0', fpsCustom: 30,
  ss: '', to: '', outputName: '',
  scaleMode: 'keep', scaleW: 1920, scaleH: 1080, scalePct: 100,
  audio: 'aac', abitrate: 128
};
const CODEC_LABEL = { libx264: 'H.264 (libx264)', libx265: 'H.265 (libx265)', copy: '视频流直通 (copy)' };

async function renderTranscode() {
  const presets = await api.transcode.presets();
  if (ffmpegOk === null) ffmpegOk = await api.system.probeFfmpeg();
  const state = await api.transcode.state();
  const p = tc;

  $('#view-transcode').innerHTML = `
  <div class="card" data-name="输入文件">
    <div class="drop" id="drop">${tc.input ? `<b>${esc(tc.input.split(/[\\/]/).pop())}</b>点击重新选择` : '<b>拖放视频到这里，或点击选择文件</b>mp4 · mkv · mov · avi · webm …'}</div>
    <div id="fileinfo" class="hint" style="margin-top:8px">${fileInfoHtml()}</div>
    ${ffmpegOk ? '' : '<div class="hint" style="color:var(--bad)">未在 PATH 中找到 ffmpeg —— 请安装 gyan.dev full build 并加入环境变量</div>'}
  </div>
  <div class="grid2">
    <div>
      <div class="card" data-name="参数">
        <h3>压缩参数</h3>
        <div class="hint">全参数可调 · 下方实时生成 FFmpeg 命令预览</div>
        <div class="setrow"><span class="lab">容器</span><span class="ctl">
          <span class="seg" id="seg-cont">${['mp4', 'mkv', 'webm'].map(c => `<button data-v="${c}" class="${p.container === c ? 'on' : ''}">${c}</button>`).join('')}</span></span></div>
        <div class="setrow"><span class="lab">视频编码器</span><span class="ctl">
          <select class="select" id="sel-codec">${Object.entries(CODEC_LABEL).map(([v, l]) => `<option value="${v}" ${p.vcodec === v ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <button class="sw ${p.nvenc ? 'on' : ''}" id="sw-nvenc" title="NVIDIA NVENC 硬件加速"></button></span></div>
        <div class="setrow"><span class="lab">码率控制</span><span class="ctl">
          <span class="seg" id="seg-mode"><button data-v="bitrate" class="${p.mode === 'bitrate' ? 'on' : ''}">目标码率</button><button data-v="crf" class="${p.mode === 'crf' ? 'on' : ''}">CRF 恒定质量</button></span></span></div>
        ${p.mode === 'bitrate' ? `
        <div class="setrow"><span class="lab">平均码率</span><span class="ctl"><input class="input" id="in-br" type="number" value="${p.bitrate}" style="width:90px"> kbps</span></div>
        <div class="setrow"><span class="lab">峰值 / 缓冲</span><span class="ctl"><input class="input" id="in-max" type="number" value="${p.maxrate}" step="0.5" style="width:80px"> M · <input class="input" id="in-buf" type="number" value="${p.bufsize}" step="0.5" style="width:80px"> M</span></div>` : `
        <div class="setrow"><span class="lab">CRF 值</span><span class="ctl"><input class="input" id="in-crf" type="number" value="${p.crf}" min="0" max="51" style="width:90px">（18≈高质 · 28≈均衡 · 40≈省空间）</span></div>`}
        <div class="setrow"><span class="lab">帧率</span><span class="ctl">
          <span class="seg" id="seg-fps">${[0, 24, 30, 60].map(f => `<button data-v="${f}" class="${p.fpsSeg === String(f) ? 'on' : ''}">${f === 0 ? '保持' : f}</button>`).join('')}<button data-v="custom" class="${p.fpsSeg === 'custom' ? 'on' : ''}">自定义</button></span></span></div>
        ${p.fpsSeg === 'custom' ? `<div class="setrow"><span class="lab">自定义帧率</span><span class="ctl"><input class="input" id="in-fpsc" type="number" value="${p.fpsCustom || 30}" min="1" max="240" style="width:80px"> fps</span></div>` : ''}
        <div class="setrow"><span class="lab">分辨率</span><span class="ctl">
          <span class="seg" id="seg-scale"><button data-v="keep" class="${p.scaleMode === 'keep' ? 'on' : ''}">保持</button><button data-v="size" class="${p.scaleMode === 'size' ? 'on' : ''}">指定</button><button data-v="percent" class="${p.scaleMode === 'percent' ? 'on' : ''}">缩放%</button></span></span></div>
        ${p.scaleMode === 'size' ? `<div class="setrow"><span class="lab">宽 × 高</span><span class="ctl"><input class="input" id="in-sw" type="number" value="${p.scaleW}" style="width:90px"> × <input class="input" id="in-sh" type="number" value="${p.scaleH}" style="width:90px"></span></div>` : ''}
        ${p.scaleMode === 'percent' ? `<div class="setrow"><span class="lab">缩放比例</span><span class="ctl"><input class="input" id="in-sp" type="number" value="${p.scalePct}" min="10" max="100" style="width:90px"> %</span></div>` : ''}
        <div class="setrow"><span class="lab">时间段<div class="d">留空转全片${p.probe && p.probe.duration > 0 ? ' · 总时长 ' + fmtDur(p.probe.duration) : ''}</div></span><span class="ctl">
          <input class="input" id="in-ss" type="number" step="0.1" min="0" placeholder="开始秒" style="width:78px" value="${p.ss}"> ~ <input class="input" id="in-to" type="number" step="0.1" min="0" placeholder="结束秒" style="width:78px" value="${p.to}"></span></div>
        <div class="setrow"><span class="lab">音频</span><span class="ctl">
          <select class="select" id="sel-audio"><option value="aac" ${p.audio === 'aac' ? 'selected' : ''}>AAC 重编码</option><option value="copy" ${p.audio === 'copy' ? 'selected' : ''}>直通 (copy)</option><option value="ac3" ${p.audio === 'ac3' ? 'selected' : ''}>AC-3</option></select>
          ${p.audio !== 'copy' ? `<input class="input" id="in-ab" type="number" value="${p.abitrate}" style="width:80px"> kbps` : ''}</span></div>
        <div class="setrow"><span class="lab">输出文件名<div class="d">留空自动命名 · 保存在源文件目录</div></span><span class="ctl">
          <input class="input" id="in-outname" type="text" value="${p.outputName}" style="width:185px" placeholder="${p.input ? esc(p.input.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')) + '.timeglass.' + p.container : '自动命名'}"></span></div>
      </div>
    </div>
    <div>
      <div class="card" data-name="预设">
        <h3>快捷预设</h3>
        <div class="presetrow">${Object.entries(presets).map(([k, v]) => `<div class="preset" data-k="${k}"><b>${v.name}</b><span>${v.vcodec === 'copy' ? '不重编码' : (v.mode === 'crf' ? 'CRF ' + v.crf : v.bitrate + 'k')} · ${v.scale || '原分辨率'}</span></div>`).join('')}</div>
      </div>
      <div class="card" data-name="命令预览">
        <h3>FFmpeg 命令预览</h3>
        <div class="hint">完全对应实际执行参数，可直接复制到终端</div>
        <div class="cmdbox" id="cmdbox"></div>
        <div class="btnrow">
          <button class="btn pri" id="btn-start" ${tc.input && ffmpegOk ? '' : 'disabled'}>加入队列并开始转码</button>
          <button class="btn" id="btn-copy">复制命令</button>
        </div>
      </div>
    </div>
  </div>
  <div class="card" data-name="队列">
    <h3>转码队列</h3>
    <div id="joblist" style="margin-top:10px"></div>
  </div>`;

  /* 交互 */
  const drop = $('#drop');
  drop.onclick = async () => {
    const f = await api.dialog.pickVideo();
    if (f) setInput(f);
  };
  drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) setInput(f.path); };

  document.querySelectorAll('#seg-cont button').forEach(b => b.onclick = async () => { tc.container = b.dataset.v; await renderTranscode(); E.apply(); });
  document.querySelectorAll('#seg-mode button').forEach(b => b.onclick = async () => { tc.mode = b.dataset.v; await renderTranscode(); E.apply(); });
  document.querySelectorAll('#seg-fps button').forEach(b => b.onclick = async () => { tc.fpsSeg = b.dataset.v; await renderTranscode(); E.apply(); });
  document.querySelectorAll('#seg-scale button').forEach(b => b.onclick = async () => { tc.scaleMode = b.dataset.v; await renderTranscode(); E.apply(); });
  $('#sel-codec').onchange = async e => { tc.vcodec = e.target.value; await renderTranscode(); E.apply(); };
  $('#sel-audio').onchange = async e => { tc.audio = e.target.value; await renderTranscode(); E.apply(); };
  const swN = $('#sw-nvenc');
  if (swN) swN.onclick = () => { tc.nvenc = !tc.nvenc; swN.classList.toggle('on', tc.nvenc); refreshCmd(); };
  const num = (id, key) => { const el = $('#' + id); if (el) el.onchange = e => { tc[key] = +e.target.value; refreshCmd(); }; };
  const txt = (id, key) => { const el = $('#' + id); if (el) el.onchange = e => { tc[key] = e.target.value; refreshCmd(); }; };
  num('in-br', 'bitrate'); num('in-max', 'maxrate'); num('in-buf', 'bufsize'); num('in-crf', 'crf');
  num('in-sw', 'scaleW'); num('in-sh', 'scaleH'); num('in-sp', 'scalePct'); num('in-ab', 'abitrate');
  num('in-fpsc', 'fpsCustom');
  txt('in-ss', 'ss'); txt('in-to', 'to'); txt('in-outname', 'outputName');

  document.querySelectorAll('.preset').forEach(el => el.onclick = async () => {
    const v = presets[el.dataset.k];
    Object.assign(tc, { container: v.container, vcodec: v.vcodec, mode: v.mode, bitrate: v.bitrate || 2500, maxrate: v.maxrate || 3, bufsize: v.bufsize || 6, crf: v.crf || 23, fpsSeg: v.fps > 0 ? String(v.fps) : '0', audio: v.audio, abitrate: v.abitrate || 128 });
    if (v.scale) { tc.scaleMode = 'size'; const [w, h] = v.scale.split(':').map(Number); tc.scaleW = w; tc.scaleH = h; }
    else tc.scaleMode = 'keep';
    await renderTranscode(); E.apply();
  });

  $('#btn-copy').onclick = () => { navigator.clipboard.writeText($('#cmdbox').textContent); toast('命令已复制'); };
  $('#btn-start').onclick = async () => {
    if (!tc.input) return;
    await api.transcode.add(previewParams());
    toast('已加入转码队列');
    renderJobs(await api.transcode.state());
  };

  renderJobs(state);
  await refreshCmd();
}

async function setInput(f) {
  tc.input = f;
  tc.probe = null;
  const drop = $('#drop');
  drop.innerHTML = `<b>${esc(f.split(/[\\/]/).pop())}</b>点击重新选择`;
  $('#btn-start').disabled = !(f && ffmpegOk);
  refreshCmd();
  const info = $('#fileinfo');
  if (info) info.textContent = '正在读取文件信息…';
  try { tc.probe = await api.transcode.probe(f); } catch (e) { tc.probe = null; }
  const info2 = $('#fileinfo');
  if (info2) info2.innerHTML = fileInfoHtml();
}
/* 组装提交/预览参数：帧率档位、截取段、输出文件路径 */
function previewParams() {
  const p = { ...tc };
  p.fps = tc.fpsSeg === 'custom' ? (+tc.fpsCustom || 30) : (+tc.fpsSeg || 0);
  p.ss = parseFloat(tc.ss) || 0;
  p.to = parseFloat(tc.to) || 0;
  if (p.to <= p.ss) p.to = 0;
  if (tc.input) {
    const dir = tc.input.replace(/[\\/][^\\/]+$/, '');
    const base = tc.input.split(/[\\/]/).pop().replace(/\.[^.]+$/, '');
    let name = (tc.outputName || '').trim() || (base + '.timeglass.' + tc.container);
    name = name.replace(/[\\/:*?"<>|]/g, '_');
    if (!/\.[a-z0-9]+$/i.test(name)) name += '.' + tc.container;
    p.output = dir + (/[\\/]$/.test(dir) ? '' : '\\') + name;
  }
  return p;
}
async function refreshCmd() {
  const box = $('#cmdbox');
  if (!box) return;
  if (!tc.input) { box.innerHTML = '<b>ffmpeg</b> -i "等待选择文件…"（命令将实时生成）'; return; }
  const cmd = await api.transcode.preview(previewParams());
  box.textContent = cmd;
  const info = $('#fileinfo');
  if (info) info.innerHTML = fileInfoHtml();
}
function fmtBytes(n) {
  if (!n) return '0 KB';
  return n >= 1024 ** 3 ? (n / 1024 ** 3).toFixed(2) + ' GB' : n >= 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB';
}
function fmtDur(s) { const m = Math.floor(s / 60), ss = Math.round(s % 60); return m + ':' + String(ss).padStart(2, '0'); }
function fileInfoHtml() {
  if (!tc.probe) return '';
  const { size, duration } = tc.probe;
  const ss = parseFloat(tc.ss) || 0, to = parseFloat(tc.to) || 0;
  const seg = to > ss ? to - ss : 0;
  const dur = seg > 0 ? seg : duration;
  let s = `源文件 ${fmtBytes(size)}`;
  if (duration > 0) s += ` · 时长 ${fmtDur(duration)}`;
  if (seg > 0) s += ` · 截取 ${fmtDur(ss)} ~ ${fmtDur(to)}`;
  if (dur > 0 && tc.mode === 'bitrate') {
    const kb = (tc.bitrate || 0) + (tc.audio !== 'copy' ? (tc.abitrate || 0) : 0);
    if (kb > 0) {
      const est = kb * 1000 * dur / 8;
      const ratio = (size && duration) ? Math.round(est / (size * (dur / duration)) * 100) : 0;
      s += ` · 预估输出 ≈ ${fmtBytes(est)}${ratio ? `（${ratio}%）` : ''}`;
    }
  } else if (dur > 0 && tc.mode === 'crf') {
    s += ' · CRF 模式输出大小取决于画面复杂度';
  }
  return s;
}
function renderJobs(state) {
  const wrap = $('#joblist');
  if (!wrap) return;
  if (!state.queue.length) { wrap.innerHTML = '<div class="empty">队列为空</div>'; return; }
  wrap.innerHTML = state.queue.map(j => `
    <div class="job ${j.status}">
      <div class="name"><b>${esc(j.params.input.split(/[\\/]/).pop())}</b>
        <span>${j.status === 'running' ? `转码中 · ${j.speed || ''}` : j.status === 'done' ? `完成 · 输出 ${j.outSize || ''}` : j.status === 'error' ? (j.error || '失败') : j.status === 'waiting' ? '排队中' : '已取消'}</span></div>
      ${j.status === 'running' ? `<div class="pbar"><i style="width:${j.progress}%"></i></div>` : ''}
      <span class="pct">${j.status === 'running' ? j.progress + '%' : j.status === 'done' ? '✓' : ''}</span>
      ${j.status === 'running' || j.status === 'waiting' ? `<button class="btn" data-cancel="${j.id}">取消</button>` : ''}
    </div>`).join('');
  wrap.querySelectorAll('[data-cancel]').forEach(b => b.onclick = async () => {
    await api.transcode.cancel(b.dataset.cancel);
  });
}

/* ============================================================
   04 · 偏好设置
   ============================================================ */
function sw(on, cfg) { return `<button class="sw ${on ? 'on' : ''}" data-cfg="${cfg || ''}"></button>`; }
function numseg(id, opts, cur, unit, cfg) {
  return `<span class="seg" id="${id}" data-cfg="${cfg || ''}">${opts.map(o => `<button data-v="${o}" class="${cur === o ? 'on' : ''}">${o}${unit || ''}</button>`).join('')}</span>`;
}

async function renderSettings() {
  const c = settings.capture, st = settings.storage, a = settings.app;
  $('#view-settings').innerHTML = `
  <div class="grid2">
    <div>
      <div class="card" data-name="采集规则">
        <h3>采集规则</h3>
        <div class="setrow"><span class="lab">定时截屏<div class="d">关闭后调度器停止</div></span><span class="ctl">${sw(c.enabled, 'capture.enabled')}</span></div>
        <div class="setrow"><span class="lab">采集间隔<div class="d">支持 1~1440 分钟任意值</div></span><span class="ctl">
          <input class="input" id="in-int" type="number" min="1" max="1440" step="1" value="${c.intervalMin}" style="width:80px"> 分钟
          <span class="seg" id="seg-int" data-cfg="capture.intervalMin">${[1, 5, 15, 30, 60].map(o => `<button data-v="${o}" class="${c.intervalMin === o ? 'on' : ''}">${o}m</button>`).join('')}</span></span></div>
        <div class="setrow"><span class="lab">采集范围<div class="d">范围外不采集 · 可选全天</div></span><span class="ctl">
          ${sw(c.allDay, 'capture.allDay')} <span>全天</span>
          <span id="range-inputs" style="display:${c.allDay ? 'none' : 'inline-flex'};gap:6px;align-items:center">
            <input class="input" id="in-rs" type="time" value="${c.rangeStart}" style="width:100px"> ~ <input class="input" id="in-re" type="time" value="${c.rangeEnd}" style="width:100px">
          </span></span></div>
        <div class="setrow"><span class="lab">画面去重<div class="d">相邻截图完全一致时跳过</div></span><span class="ctl">${sw(c.dedupe, 'capture.dedupe')}</span></div>
      </div>
      <div class="card" data-name="元数据">
        <h3>窗口戳与时间戳</h3>
        <div class="hint">信息只写入元数据库，截图画面保持干净</div>
        <div class="setrow"><span class="lab">记录时间戳</span><span class="ctl">${sw(c.writeTimestampMeta, 'capture.writeTimestampMeta')}</span></div>
        <div class="setrow"><span class="lab">记录窗口戳<div class="d">前台窗口应用名 + 窗口标题</div></span><span class="ctl">${sw(c.writeWindowMeta, 'capture.writeWindowMeta')}</span></div>
        <div class="hint" style="margin-top:8px">写入示例 · <code style="font-family:Consolas,monospace">14:32:05 · chrome · 「产品文档 - 时璃」.docx</code></div>
      </div>
      <div class="card" data-name="存储与保留">
        <h3>存储与保留</h3>
        <div class="setrow"><span class="lab">存储目录</span><span class="ctl">
          <input class="input" id="in-dir" value="${esc(st.dir)}" readonly style="width:230px;font-size:11px">
          <button class="btn" id="btn-dir">浏览</button></span></div>
        <div class="setrow"><span class="lab">保留天数<div class="d">0 = 永久保留</div></span><span class="ctl">${numseg('seg-keep', [0, 30, 90, 365], st.keepDays, ' 天', 'storage.keepDays')}</span></div>
        <div class="setrow"><span class="lab">空间上限</span><span class="ctl">
          <input type="range" id="in-gb" min="1" max="20" step="1" value="${st.maxGB}">
          <span class="valbadge" id="lb-gb">${st.maxGB} GB</span></span></div>
        <div class="hint" style="margin-top:8px">超出后自动从最旧的截图开始清理（文件与元数据同步删除）</div>
      </div>
    </div>
    <div>
      <div class="card" data-name="托盘与启动">
        <h3>托盘与启动</h3>
        <div class="setrow"><span class="lab">开机自动启动<div class="d">启动后静默驻留托盘</div></span><span class="ctl">${sw(a.autostart, 'app.autostart')}</span></div>
        <div class="setrow"><span class="lab">启动时静默到托盘</span><span class="ctl">${sw(a.silentToTray, 'app.silentToTray')}</span></div>
        <div class="setrow"><span class="lab">关闭按钮最小化到托盘<div class="d">关闭 = 后台常驻</div></span><span class="ctl">${sw(a.minimizeToTray, 'app.minimizeToTray')}</span></div>
        <div class="setrow"><span class="lab">暂停/恢复热键</span><span class="ctl"><input class="input" id="in-hotkey" value="${esc(a.hotkey)}" style="width:170px" readonly><button class="btn" id="btn-hotkey">切换为 Ctrl+Alt+S</button></span></div>
      </div>
      <div class="card" data-name="隐私与暂停">
        <h3>隐私与暂停</h3>
        <div class="setrow"><span class="lab">锁屏时暂停<div class="d">系统锁屏期间不采集</div></span><span class="ctl">${sw(c.pauseOnLock, 'capture.pauseOnLock')}</span></div>
        <div class="setrow"><span class="lab">全屏应用暂停<div class="d">前台窗口铺满屏幕时跳过</div></span><span class="ctl">${sw(c.pauseOnFullscreen, 'capture.pauseOnFullscreen')}</span></div>
        <div class="setrow"><span class="lab">空闲自动暂停<div class="d">键鼠长期不活跃时暂停截屏</div></span><span class="ctl">${sw(c.pauseOnIdle, 'capture.pauseOnIdle')}</span></div>
        <div class="setrow"><span class="lab">空闲判定<div class="d">不活跃多少分钟后判定为空闲</div></span><span class="ctl">
          <input class="input" id="in-idle" type="number" min="1" max="240" value="${c.idleMinutes}" style="width:80px"> 分钟</span></div>
        <div class="setrow" style="align-items:flex-start"><span class="lab" style="padding-top:6px">排除应用<div class="d">前台进程命中名单时跳过采集</div></span>
          <span class="ctl"><input class="input" id="in-excl" placeholder="如 chrome, Code, figma（逗号分隔）" value="${esc((c.excludeApps || []).join(', '))}" style="width:240px"></span></div>
        <div class="setrow"><span class="lab">临时暂停<div class="d">自定义暂停时长（分钟）</div></span><span class="ctl">
          <input class="input" id="in-pause-min" type="number" min="1" max="1440" value="30" style="width:80px"> 分钟
          <button class="btn" id="btn-pause-custom">暂停</button></span></div>
        <div class="btnrow" style="margin-top:10px">
          <button class="btn" id="btn-pause30">暂停 30 分钟</button>
          <button class="btn" id="btn-pause1h">暂停 1 小时</button>
          <button class="btn" id="btn-pause2m">暂停到明天</button>
          <button class="btn ${captureStatus?.paused ? 'pri' : ''}" id="btn-resume">${captureStatus?.paused ? '恢复采集' : '当前未暂停'}</button>
        </div>
      </div>
      <div class="card" data-name="数据">
        <h3>数据</h3>
        <div class="hint">截图：${esc(st.dir)}<br>设置与元数据：应用数据目录（settings.json / meta.json）</div>
        <div class="btnrow">
          <button class="btn" id="btn-openstore">打开截图目录</button>
          <button class="btn" id="btn-now">立即截屏</button>
        </div>
      </div>
    </div>
  </div>`;

  /* 交互：开关（data-cfg 驱动，保存后局部更新，不重建） */
  async function saveCfg(cfg, value) {
    if (!cfg) return;
    const [sec, key] = cfg.split('.');
    settings = await api.settings.save({ [sec]: { [key]: value } });
    toast('设置已保存');
  }
  document.querySelectorAll('#view-settings .sw').forEach(btn => {
    btn.onclick = () => {
      const on = btn.classList.toggle('on');
      saveCfg(btn.dataset.cfg, on);
      if (btn.dataset.cfg === 'capture.allDay') {
        const ri = $('#range-inputs');
        if (ri) ri.style.display = on ? 'none' : 'inline-flex';
      }
    };
  });
  document.querySelectorAll('#view-settings .seg').forEach(seg => {
    seg.querySelectorAll('button').forEach(b => b.onclick = () => {
      seg.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
      saveCfg(seg.dataset.cfg, +b.dataset.v);
      if (seg.id === 'seg-int') { const ii = $('#in-int'); if (ii) ii.value = +b.dataset.v; }
    });
  });
  const inInt = $('#in-int');
  if (inInt) inInt.onchange = async () => {
    const v = Math.min(1440, Math.max(1, +inInt.value || 1));
    inInt.value = v;
    settings = await api.settings.save({ capture: { intervalMin: v } });
    document.querySelectorAll('#seg-int button').forEach(x => x.classList.toggle('on', +x.dataset.v === v));
    toast('采集间隔已保存');
  };
  const rs = $('#in-rs'), re = $('#in-re');
  rs.onchange = async () => { settings = await api.settings.save({ capture: { rangeStart: rs.value } }); toast('采集范围已保存'); };
  re.onchange = async () => { settings = await api.settings.save({ capture: { rangeEnd: re.value } }); toast('采集范围已保存'); };
  const gb = $('#in-gb');
  gb.oninput = () => $('#lb-gb').textContent = gb.value + ' GB';
  gb.onchange = async () => { settings = await api.settings.save({ storage: { maxGB: +gb.value } }); toast('空间上限已保存'); };
  $('#btn-dir').onclick = async () => {
    const d = await api.dialog.pickStorageDir();
    if (d) { settings = await api.settings.save({ storage: { dir: d } }); $('#in-dir').value = d; toast('存储目录已更新'); }
  };
  $('#btn-hotkey').onclick = async () => {
    settings = await api.settings.save({ app: { hotkey: 'Control+Alt+S' } });
    await api.app.rehotkey('Control+Alt+S');
    $('#in-hotkey').value = 'Control+Alt+S';
    toast('热键已切换为 Ctrl+Alt+S');
  };
  $('#in-excl').onchange = async e => {
    const list = e.target.value.split(/[,,]/).map(s => s.trim()).filter(Boolean);
    settings = await api.settings.save({ capture: { excludeApps: list } });
    toast('排除名单已保存');
  };
  const inIdle = $('#in-idle');
  if (inIdle) inIdle.onchange = async () => {
    const v = Math.min(240, Math.max(1, +inIdle.value || 15));
    inIdle.value = v;
    settings = await api.settings.save({ capture: { idleMinutes: v } });
    toast('空闲判定已保存');
  };
  $('#btn-pause30').onclick = () => pauseFor(30);
  $('#btn-pause1h').onclick = () => pauseFor(60);
  $('#btn-pause2m').onclick = () => pauseFor(16 * 60);
  $('#btn-pause-custom').onclick = () => {
    const min = Math.min(1440, Math.max(1, +($('#in-pause-min').value) || 30));
    pauseFor(min);
  };
  $('#btn-resume').onclick = async () => { await api.capture.resume(); toast('已恢复'); };
  $('#btn-openstore').onclick = () => api.shell.openPath(settings.storage.dir);
  $('#btn-now').onclick = async () => {
    const r = await api.capture.now();
    toast(r.ok ? '已保存截图 ' + fmtTime(r.rec.ts) : (r.skipped ? '本次跳过（' + r.skipped + '）' : '失败'));
    refreshStats();
  };
}
async function pauseFor(min) {
  await api.capture.pauseFor(min * 60000);
  toast('采集已暂停 ' + min + ' 分钟');
}

/* ============================================================
   05 · 外观与皮肤
   ============================================================ */
function renderAppearance() {
  const S = E.S;
  const builtin = Object.keys(E.WALLS);
  $('#view-appearance').innerHTML = `
  <div class="grid2">
    <div>
      <div class="card" data-name="壁纸与取色">
        <h3>壁纸</h3>
        <div class="hint">导入任意图片 · 引擎自动取种子色并生成整套玻璃主题</div>
        <div class="wallrow">
          ${builtin.map(k => `<div class="wthumb ${!S.img && S.wall === k ? 'on' : ''}" data-wall="${k}">
            <span class="grad" style="background:linear-gradient(160deg, ${E.WALLS[k].stops.map(s => s[1] + ' ' + Math.round(s[0] * 100) + '%').join(',')})"></span>
            <span class="lab">${{ amber: '琥珀', cyan: '冷青', violet: '紫棠' }[k]}</span></div>`).join('')}
          <div class="wthumb add" id="w-add">＋<span>导入本地图片</span></div>
        </div>
        <div style="margin-top:14px">
          <div class="setrow"><span class="lab">采样方式<div class="d">决定候选主题色如何生成</div></span><span class="ctl">
            <span class="seg" id="seg-sample">
              <button data-v="ring" class="${S.seedMode === 'ring' ? 'on' : ''}">整体色调</button>
              <button data-v="cluster" class="${S.seedMode === 'cluster' ? 'on' : ''}">主色簇</button>
            </span></span></div>
          <div class="setrow"><span class="lab">明暗模式</span><span class="ctl">
            <span class="seg" id="seg-mode">${[['dark', '深色'], ['light', '浅色']].map(([v, l]) => `<button data-v="${v}" class="${S.mode === v ? 'on' : ''}">${l}</button>`).join('')}</span></span></div>
        </div>
      </div>
      <div class="card" data-name="候选种子">
        <h3>主题色</h3>
        <div class="hint" id="seed-hint">${S.manualSeed ? '已手动选定主题色 · 点击其他色块可更换' : '当前主题色来自采样 · 点击任意色块可手动指定'}</div>
        <div class="seedcards" id="seedcards"></div>
      </div>
      <div class="card" data-name="材质">
        <h3>材质全局</h3>
        <div class="setrow"><span class="lab">不透明度 α</span><span class="ctl"><input type="range" id="sl-alpha" min="0" max="1" step="0.02" value="${S.params.alpha}"><span class="valbadge" id="lb-alpha">${Math.round(S.params.alpha * 100)}%</span></span></div>
        <div class="setrow"><span class="lab">背景模糊</span><span class="ctl"><input type="range" id="sl-blur" min="0" max="60" step="2" value="${S.params.blur}"><span class="valbadge" id="lb-blur">${S.params.blur}px</span></span></div>
        <div class="setrow"><span class="lab">圆角倍率</span><span class="ctl"><input type="range" id="sl-radius" min="0" max="2" step="0.1" value="${S.params.radius}"><span class="valbadge" id="lb-radius">${S.params.radius}×</span></span></div>
        <div class="setrow"><span class="lab">阴影层级</span><span class="ctl"><input type="range" id="sl-shadow" min="0" max="3" step="1" value="${S.params.shadow}"><span class="valbadge" id="lb-shadow">${S.params.shadow}</span></span></div>
      </div>
    </div>
    <div>
      <div class="card" data-name="皮肤包">
        <h3>皮肤包三层</h3>
        <div class="hint">user 我的覆盖 → app 玻璃增强 → base 基础包（上层只改声明过的槽）</div>
        ${['user', 'app', 'base'].map(id => {
          const L = E.LAYERS[id];
          const n = id === 'user' ? Object.keys(L.params).length + Object.keys(L.slots).length : Object.keys(L.slots).length;
          return `<div class="setrow"><span class="lab">${L.name}<div class="d">${id === 'user' ? (n ? n + ' 项覆盖' : '无覆盖') : '槽位 ' + n + ' 项'}</div></span>
            <span class="ctl">${id === 'base' ? '<span class="valbadge">内置</span>' : `<button class="sw ${L.enabled !== false ? 'on' : ''}" data-layer="${id}"></button>`}</span></div>`;
        }).join('')}
        <div class="btnrow"><button class="btn" id="btn-clearuser">清除我的覆盖</button></div>
      </div>
      <div class="card" data-name="材质槽">
        <h3>五材质槽偏移</h3>
        <div class="hint">相对全局 α 的偏移，在 0/1 两端自动收敛</div>
        ${[['rail', '侧栏'], ['nav', '标签栏'], ['card', '卡片'], ['input', '输入'], ['list', '列表']].map(([k, l]) => `
          <div class="slotrow"><span class="sn">${l}</span><input type="range" data-slot="${k}" min="-0.4" max="0.4" step="0.02" value="${S.slots[k] ?? 0}"><span class="valbadge" data-slotv="${k}">${(S.slots[k] ?? 0).toFixed(2)}</span></div>`).join('')}
      </div>
    </div>
  </div>
  <div class="card" data-name="实时预览">
    <h3>实时预览</h3>
    <div class="minishell" id="minishell">
      <span class="mr" data-solve="迷你侧栏" data-solve-kind="input"></span>
      <span class="mt" data-solve="迷你顶栏" data-solve-kind="input"></span>
      <span class="mc" data-solve="迷你卡片" data-solve-kind="list"></span>
      <span class="mb" data-solve="迷你按钮" data-solve-kind="input"></span>
    </div>
    <div style="margin-top:14px" id="crlist"></div>
  </div>`;

  document.querySelectorAll('.wthumb[data-wall]').forEach(w => w.onclick = () => {
    E.setBuiltinWallpaper(w.dataset.wall);
    renderAppearance(); E.apply();
  });
  $('#w-add').onclick = async () => {
    const url = await api.dialog.pickWallpaper();
    if (!url) return;
    E.setWallpaperFromDataUrl(url, () => { renderAppearance(); E.apply(); });
  };
  // 采样方式：整体色调 / 主色簇（决定候选色生成；切换会清除手动覆盖）
  document.querySelectorAll('#seg-sample button').forEach(b => b.onclick = () => {
    E.setSampleMode(b.dataset.v);
    renderAppearance(); E.apply();
  });
  document.querySelectorAll('#seg-mode button').forEach(b => b.onclick = () => {
    E.setUser('mode', null, b.dataset.v);
    renderAppearance(); E.apply();
  });

  /* 主题色候选卡（始终可点，点击 = 手动指定主题色） */
  const sc = $('#seedcards');
  if (S.candidates && S.candidates.length) {
    sc.innerHTML = S.candidates.map((c, i) => {
      const h = window.MCU.Hct.fromInt(c.seed);
      const u = c.seed >>> 0;
      const rgb = ((u >> 16) & 255) + ',' + ((u >> 8) & 255) + ',' + (u & 255);
      // 高亮 = 当前有效主题色（手动覆盖或采样结果），无论来源
      const on = S.seed === c.seed;
      return `<div class="seedcard ${on ? 'on' : ''}" data-seed="${c.seed}"><div class="chip" style="background:rgb(${rgb})"></div><div class="t">${c.tag}</div><div class="hex">H${Math.round(h.hue)} C${Math.round(h.chroma)} T${Math.round(h.tone)}</div></div>`;
    }).join('');
    sc.querySelectorAll('.seedcard').forEach(cd => cd.onclick = () => {
      E.setThemeSeed(+cd.dataset.seed);
      renderAppearance(); E.apply();
    });
  } else sc.innerHTML = '<div class="empty">导入壁纸后自动生成候选</div>';

  /* 滑块 */
  const slider = (id, key, fmt) => {
    const el = $('#' + id);
    el.oninput = () => { $('#' + 'lb-' + id.split('-')[1]).textContent = fmt(el.value); };
    el.onchange = () => E.setUser('params', key, +el.value);
  };
  slider('sl-alpha', 'alpha', v => Math.round(v * 100) + '%');
  slider('sl-blur', 'blur', v => v + 'px');
  slider('sl-radius', 'radius', v => v + '×');
  slider('sl-shadow', 'shadow', v => v);
  document.querySelectorAll('[data-slot]').forEach(s => {
    s.oninput = () => { document.querySelector(`[data-slotv="${s.dataset.slot}"]`).textContent = (+s.value).toFixed(2); };
    s.onchange = () => E.setUser('slots', s.dataset.slot, +s.value);
  });

  /* 皮肤包开关 */
  document.querySelectorAll('[data-layer]').forEach(b => b.onclick = () => {
    const id = b.dataset.layer;
    E.LAYERS[id].enabled = !(E.LAYERS[id].enabled !== false);
    b.classList.toggle('on', E.LAYERS[id].enabled !== false);
    E.syncAll(); E.saveState();
    renderAppearance(); E.apply();
  });
  $('#btn-clearuser').onclick = () => { E.clearUser(); renderAppearance(); E.apply(); toast('已清除我的覆盖'); };

  refreshCR();
}

/* 可读性 CR 检查表 */
function refreshCR() {
  const box = $('#crlist');
  if (!box) return;
  const rs = E.S.results || [];
  if (!rs.length) { box.innerHTML = '<div class="empty">等待求解…</div>'; return; }
  box.innerHTML = rs.slice(0, 8).map(r => `
    <div class="crline">
      <span>${esc(r.name)}</span>
      <span class="${r.ok ? 'ok' : 'lift'}">CR ${r.ratio.toFixed(1)} ${r.ok ? '· 通过' : '· 不达标'}${r.adjusted ? ' · 已抬升' : ''}</span>
    </div>`).join('');
}

/* ============================================================
   状态栏 / 事件 / 启动
   ============================================================ */
function renderStatus(st) {
  if (!st) return; // 防御：payload 缺失时保持上次状态，避免倒计时卡死
  captureStatus = st;
  const chip = $('#statuschip');
  const txt = $('#status-text');
  $('#rail').classList.toggle('paused', !!(st.paused || st.idlePaused));
  if (st.paused) {
    const left = Math.max(0, st.pausedUntil - Date.now());
    const m = Math.ceil(left / 60000);
    txt.textContent = `已暂停 · ${m >= 60 ? Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分后恢复' : m + ' 分钟后恢复'}`;
    chip.classList.add('paused');
  } else if (st.idlePaused) {
    txt.textContent = '空闲暂停 · 键鼠不活跃';
    chip.classList.add('paused');
  } else {
    const left = Math.max(0, st.nextShotAt - Date.now());
    const s = Math.ceil(left / 1000);
    txt.textContent = st.enabled ? `下次采集 ${s >= 60 ? Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0') : s + ' 秒'}` : '定时采集已关闭';
    chip.classList.remove('paused');
  }
  // 同步设置页暂停/恢复按钮（不重建设置页，只更新按钮）
  const rb = $('#btn-resume');
  if (rb) {
    rb.textContent = st.paused ? '恢复采集' : '当前未暂停';
    rb.classList.toggle('pri', !!st.paused);
  }
}

async function refreshStats() {
  stats = await api.meta.stats();
  if ($('#view-timeline').classList.contains('on')) { await renderTimeline(); E.apply(); }
}

/* 引擎每次求解完成后，若外观页开着就刷新 CR 表 */
window.addEventListener('tg-applied', () => {
  if ($('#view-appearance').classList.contains('on')) refreshCR();
});

/* 窗口变化时重采样（节流） */
let rzTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(rzTimer);
  rzTimer = setTimeout(() => E.apply(), 200);
});

/* 帧刷新：状态栏倒计时 */
setInterval(() => { if (captureStatus) renderStatus(captureStatus); }, 1000);

async function boot() {
  settings = await api.settings.get();
  stats = await api.meta.stats();

  E.init();
  await new Promise(r => setTimeout(r, 60)); // 等首帧壁纸画完

  document.querySelectorAll('.rail .rbtn').forEach(b => b.onclick = () => goto(b.dataset.view));
  $('#btn-min').onclick = () => api.win.minimize();
  $('#btn-max').onclick = () => api.win.toggleMaximize();
  $('#btn-close').onclick = () => api.win.close();
  $('#titlebar').addEventListener('dblclick', e => {
    if (e.target.closest('.winbtns')) return;
    api.win.toggleMaximize();
  });
  api.on.maximize(m => $('#btn-max').textContent = m ? '❐' : '□');

  api.on.status(renderStatus);
  api.on.shotTaken(rec => {
    imgCache.delete(rec.file);
    refreshStats();
    toast('已采集 ' + fmtTime(rec.ts) + (rec.app ? ' · ' + rec.app : ''));
  });
  api.on.shotDeleted(() => refreshStats());
  // 设置改动只更新本地缓存，绝不重建设置页（否则会丢未提交的输入）
  api.on.settings(s => { settings = s; });
  api.on.transcode(state => {
    if ($('#view-transcode').classList.contains('on')) renderJobs(state);
  });
  api.on.theme(() => { E.apply(); });

  goto('timeline');
}
document.addEventListener('DOMContentLoaded', boot);
})();
