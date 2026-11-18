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

/* 缩略图缓存：file -> dataURL */
const imgCache = new Map();
async function thumbOf(file, maxW = 360) {
  if (imgCache.has(file)) return imgCache.get(file);
  const url = await api.meta.image(file);
  if (url) imgCache.set(file, url);
  return url;
}

/* ---------------- 全局状态 ---------------- */
let settings = null;
let stats = null;
let captureStatus = null;
let curDay = dayKey(Date.now());
let calMonth = new Date(); calMonth.setDate(1);
let archFilter = { q: '', app: '' };
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
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('on', v.id === 'view-' + view));
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
  const view = $('#view-timeline');
  const shots = await api.meta.list({ fromTs: Date.now() - 864e5, limit: 400 });
  const byHour = {};
  for (const s of shots) byHour[new Date(s.ts).getHours()] = (byHour[new Date(s.ts).getHours()] || 0) + 1;
  const hours = Object.keys(byHour).map(Number).sort((a, b) => b - a).slice(0, 4);

  const cal = buildCalendar();
  const topApps = Object.entries(stats?.byApp || {}).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const maxApp = topApps.length ? topApps[0][1] : 1;

  view.innerHTML = `
  <div class="grid2">
    <div>
      <div class="card" data-name="时段记录">
        <h3>今天与最近 24 小时</h3>
        <div class="hint">截图画面保持干净 · 时间与窗口信息写在元数据里</div>
        ${hours.length ? hours.map(h => `
          <div class="hourrow">
            <div class="hlab">${String(h).padStart(2, '0')}时</div>
            <div class="thumbs" data-hour="${h}"></div>
          </div>`).join('') : '<div class="empty">还没有采集记录 —— 等待第一个间隔跑完，或点右上角「立即截屏」</div>'}
      </div>
      <div class="card" data-name="应用分布">
        <h3>最近 7 天应用分布</h3>
        <div class="hint">来自窗口戳元数据（前台窗口进程名）</div>
        ${topApps.length ? topApps.map(([app, n]) => `
          <div class="appbar">
            <div class="top"><span class="n">${esc(app)}</span><b>${n} 张</b></div>
            <div class="bar"><i style="width:${Math.max(4, n / maxApp * 100)}%"></i></div>
          </div>`).join('') : '<div class="empty">开启「窗口戳元数据」后，这里会按应用统计截图数量</div>'}
      </div>
    </div>
    <div>
      <div class="card" data-name="日历">
        <div class="calhead">
          <b>${calMonth.getFullYear()} 年 ${calMonth.getMonth() + 1} 月</b>
          <span class="nav"><button id="cal-prev">‹</button><button id="cal-today">今</button><button id="cal-next">›</button></span>
        </div>
        <div class="cal">${cal.html}</div>
      </div>
      <div class="card" data-name="今日统计">
        <h3>采集统计</h3>
        <div class="statrow" style="margin-top:10px">
          <div class="stat"><b>${stats?.todayCount ?? 0}</b><span>今天</span></div>
          <div class="stat"><b>${stats?.weekCount ?? 0}</b><span>7 天</span></div>
          <div class="stat"><b>${stats?.total ?? 0}</b><span>累计</span></div>
        </div>
        <div class="hint" style="margin-top:12px;margin-bottom:0">存储目录：${esc(settings.storage.dir)}<br>
        保留 ${settings.storage.keepDays || '∞'} 天 · 上限 ${settings.storage.maxGB} GB · 到达后自动从最旧开始清理</div>
      </div>
    </div>
  </div>`;

  // 缩略图懒加载
  for (const h of hours) {
    const wrap = view.querySelector(`.thumbs[data-hour="${h}"]`);
    const list = shots.filter(s => new Date(s.ts).getHours() === h).sort((a, b) => b.ts - a.ts).slice(0, 8);
    for (const s of list) {
      const d = document.createElement('div');
      d.className = 'thumb';
      d.innerHTML = `<img alt=""><span class="t">${fmtTime(s.ts)}</span>`;
      wrap.appendChild(d);
      thumbOf(s.file).then(url => { if (url) d.querySelector('img').src = url; });
      d.onclick = () => openDetail(s);
    }
  }

  view.querySelector('#cal-prev').onclick = async () => { calMonth.setMonth(calMonth.getMonth() - 1); await renderTimeline(); E.apply(); };
  view.querySelector('#cal-next').onclick = async () => { calMonth.setMonth(calMonth.getMonth() + 1); await renderTimeline(); E.apply(); };
  view.querySelector('#cal-today').onclick = async () => { calMonth = new Date(); calMonth.setDate(1); curDay = dayKey(Date.now()); await renderTimeline(); E.apply(); };
  view.querySelectorAll('.cal .cell[data-day]').forEach(c => c.onclick = () => {
    curDay = c.dataset.day;
    archFilter = { q: '', app: '' };
    goto('archive');
  });
}

function buildCalendar() {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  const first = new Date(y, m, 1);
  const start = (first.getDay() + 6) % 7; // 周一开头
  const days = new Date(y, m + 1, 0).getDate();
  const byDay = stats?.byDay || {};
  const todayK = dayKey(Date.now());
  let html = '一二三四五六日'.split('').map(d => `<span class="dow">${d}</span>`).join('');
  for (let i = 0; i < start; i++) html += '<span class="cell dim"></span>';
  for (let d = 1; d <= days; d++) {
    const k = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const n = byDay[k] || 0;
    html += `<span class="cell ${n ? 'has' : ''} ${k === todayK ? 'today' : ''} ${k === curDay ? 'sel' : ''}" data-day="${k}">${d}${n ? `<span class="cnt">${n}</span>` : ''}</span>`;
  }
  return { html };
}

/* ============================================================
   02 · 归档
   ============================================================ */
async function renderArchive() {
  const view = $('#view-archive');
  const q = {};
  if (archFilter.q) q.title = archFilter.q;
  if (archFilter.app) q.app = archFilter.app;
  let shots = await api.meta.list({ ...q, limit: 300 });
  if (archFilter.day) { shots = shots.filter(s => dayKey(s.ts) === archFilter.day); }

  view.innerHTML = `
  <div class="card" data-name="检索">
    <div class="filters">
      <input class="input" id="f-q" placeholder="按窗口标题检索…" style="flex:1" value="${esc(archFilter.q)}">
      <input class="input" id="f-app" placeholder="应用名…" style="width:160px" value="${esc(archFilter.app)}">
      <button class="btn" id="f-clear">清除</button>
      ${archFilter.day ? `<span class="statuschip">${archFilter.day} <button id="f-unday">✕</button></span>` : ''}
    </div>
    ${shots.length ? `<div class="archgrid" id="archgrid"></div>` : '<div class="empty">没有匹配的截图</div>'}
  </div>`;

  const grid = view.querySelector('#archgrid');
  for (const s of shots.slice(0, 60)) {
    const d = document.createElement('div');
    d.className = 'archcard';
    d.innerHTML = `<img alt=""><div class="m"><span class="app">${esc(s.app || '·')}</span><span>${dayKey(s.ts).slice(5)} ${fmtTime(s.ts)}</span></div>`;
    grid.appendChild(d);
    thumbOf(s.file).then(url => { if (url) d.querySelector('img').src = url; });
    d.onclick = () => openDetail(s);
  }

  view.querySelector('#f-q').oninput = e => { archFilter.q = e.target.value; debounceRender(); };
  view.querySelector('#f-app').oninput = e => { archFilter.app = e.target.value; debounceRender(); };
  view.querySelector('#f-clear').onclick = async () => { archFilter = { q: '', app: '' }; await renderArchive(); E.apply(); };
  const unday = view.querySelector('#f-unday');
  if (unday) unday.onclick = async () => { delete archFilter.day; await renderArchive(); E.apply(); };
}
let debTimer = null;
function debounceRender() {
  clearTimeout(debTimer);
  debTimer = setTimeout(async () => { await renderArchive(); E.apply(); }, 350);
}

/* 详情面板 */
async function openDetail(s) {
  const url = await thumbOf(s.file, 0) || await api.meta.image(s.file);
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
  input: null,
  container: 'mp4', vcodec: 'libx264', nvenc: false,
  mode: 'bitrate', bitrate: 2500, maxrate: 3, bufsize: 6, crf: 23,
  fps: 0, scaleMode: 'keep', scaleW: 1920, scaleH: 1080, scalePct: 100,
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
    <div class="drop" id="drop"><b>拖放视频到这里，或点击选择文件</b>mp4 · mkv · mov · avi · webm …</div>
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
          <span class="seg" id="seg-fps">${[0, 24, 30, 60].map(f => `<button data-v="${f}" class="${p.fps === f ? 'on' : ''}">${f === 0 ? '保持' : f}</button>`).join('')}</span></span></div>
        <div class="setrow"><span class="lab">分辨率</span><span class="ctl">
          <span class="seg" id="seg-scale"><button data-v="keep" class="${p.scaleMode === 'keep' ? 'on' : ''}">保持</button><button data-v="size" class="${p.scaleMode === 'size' ? 'on' : ''}">指定</button><button data-v="percent" class="${p.scaleMode === 'percent' ? 'on' : ''}">缩放%</button></span></span></div>
        ${p.scaleMode === 'size' ? `<div class="setrow"><span class="lab">宽 × 高</span><span class="ctl"><input class="input" id="in-sw" type="number" value="${p.scaleW}" style="width:90px"> × <input class="input" id="in-sh" type="number" value="${p.scaleH}" style="width:90px"></span></div>` : ''}
        ${p.scaleMode === 'percent' ? `<div class="setrow"><span class="lab">缩放比例</span><span class="ctl"><input class="input" id="in-sp" type="number" value="${p.scalePct}" min="10" max="100" style="width:90px"> %</span></div>` : ''}
        <div class="setrow"><span class="lab">音频</span><span class="ctl">
          <select class="select" id="sel-audio"><option value="aac" ${p.audio === 'aac' ? 'selected' : ''}>AAC 重编码</option><option value="copy" ${p.audio === 'copy' ? 'selected' : ''}>直通 (copy)</option><option value="ac3" ${p.audio === 'ac3' ? 'selected' : ''}>AC-3</option></select>
          ${p.audio !== 'copy' ? `<input class="input" id="in-ab" type="number" value="${p.abitrate}" style="width:80px"> kbps` : ''}</span></div>
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
  document.querySelectorAll('#seg-fps button').forEach(b => b.onclick = async () => { tc.fps = +b.dataset.v; await renderTranscode(); E.apply(); });
  document.querySelectorAll('#seg-scale button').forEach(b => b.onclick = async () => { tc.scaleMode = b.dataset.v; await renderTranscode(); E.apply(); });
  $('#sel-codec').onchange = async e => { tc.vcodec = e.target.value; await renderTranscode(); E.apply(); };
  $('#sel-audio').onchange = async e => { tc.audio = e.target.value; await renderTranscode(); E.apply(); };
  const swN = $('#sw-nvenc');
  if (swN) swN.onclick = () => { tc.nvenc = !tc.nvenc; swN.classList.toggle('on', tc.nvenc); refreshCmd(); };
  const num = (id, key) => { const el = $('#' + id); if (el) el.onchange = e => { tc[key] = +e.target.value; refreshCmd(); }; };
  num('in-br', 'bitrate'); num('in-max', 'maxrate'); num('in-buf', 'bufsize'); num('in-crf', 'crf');
  num('in-sw', 'scaleW'); num('in-sh', 'scaleH'); num('in-sp', 'scalePct'); num('in-ab', 'abitrate');

  document.querySelectorAll('.preset').forEach(el => el.onclick = async () => {
    const v = presets[el.dataset.k];
    Object.assign(tc, { container: v.container, vcodec: v.vcodec, mode: v.mode, bitrate: v.bitrate || 2500, maxrate: v.maxrate || 3, bufsize: v.bufsize || 6, crf: v.crf || 23, fps: v.fps || 0, audio: v.audio, abitrate: v.abitrate || 128 });
    if (v.scale) { tc.scaleMode = 'size'; const [w, h] = v.scale.split(':').map(Number); tc.scaleW = w; tc.scaleH = h; }
    else tc.scaleMode = 'keep';
    await renderTranscode(); E.apply();
  });

  $('#btn-copy').onclick = () => { navigator.clipboard.writeText($('#cmdbox').textContent); toast('命令已复制'); };
  $('#btn-start').onclick = async () => {
    if (!tc.input) return;
    await api.transcode.add({ ...tc });
    toast('已加入转码队列');
    renderJobs(await api.transcode.state());
  };

  renderJobs(state);
  refreshCmd();
}

function setInput(f) {
  tc.input = f;
  const drop = $('#drop');
  drop.innerHTML = `<b>${esc(f.split(/[\\/]/).pop())}</b>点击重新选择`;
  $('#btn-start').disabled = !(f && ffmpegOk);
  refreshCmd();
}
async function refreshCmd() {
  const box = $('#cmdbox');
  if (!box) return;
  if (!tc.input) { box.innerHTML = '<b>ffmpeg</b> -i "等待选择文件…"（命令将实时生成）'; return; }
  const cmd = await api.transcode.preview({ ...tc });
  box.textContent = cmd;
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
      </div>
      <div class="card" data-name="材质">
        <h3>材质全局</h3>
        <div class="setrow"><span class="lab">不透明度 α</span><span class="ctl"><input type="range" id="sl-alpha" min="0" max="1" step="0.02" value="${S.params.alpha}"><span class="valbadge" id="lb-alpha">${Math.round(S.params.alpha * 100)}%</span></span></div>
        <div class="setrow"><span class="lab">背景模糊</span><span class="ctl"><input type="range" id="sl-blur" min="0" max="60" step="2" value="${S.params.blur}"><span class="valbadge" id="lb-blur">${S.params.blur}px</span></span></div>
        <div class="setrow"><span class="lab">圆角倍率</span><span class="ctl"><input type="range" id="sl-radius" min="0" max="2" step="0.1" value="${S.params.radius}"><span class="valbadge" id="lb-radius">${S.params.radius}×</span></span></div>
        <div class="setrow"><span class="lab">阴影层级</span><span class="ctl"><input type="range" id="sl-shadow" min="0" max="3" step="1" value="${S.params.shadow}"><span class="valbadge" id="lb-shadow">${S.params.shadow}</span></span></div>
      </div>
      <div class="card" data-name="材质槽">
        <h3>五材质槽偏移</h3>
        <div class="hint">相对全局 α 的偏移，在 0/1 两端自动收敛</div>
        ${[['rail', '侧栏'], ['nav', '标签栏'], ['card', '卡片'], ['input', '输入'], ['list', '列表']].map(([k, l]) => `
          <div class="slotrow"><span class="sn">${l}</span><input type="range" data-slot="${k}" min="-0.4" max="0.4" step="0.02" value="${S.slots[k] ?? 0}"><span class="valbadge" data-slotv="${k}">${(S.slots[k] ?? 0).toFixed(2)}</span></div>`).join('')}
      </div>
    </div>
    <div>
      <div class="card" data-name="实时预览">
        <h3>实时预览</h3>
        <div class="minishell" id="minishell">
          <span class="mr" data-solve="迷你侧栏" data-solve-kind="input"></span>
          <span class="mt" data-solve="迷你顶栏" data-solve-kind="input"></span>
          <span class="mc" data-solve="迷你卡片" data-solve-kind="list"></span>
          <span class="mb" data-solve="迷你按钮" data-solve-kind="input"></span>
        </div>
        <div style="margin-top:14px" id="crlist"></div>
      </div>
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
    </div>
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
