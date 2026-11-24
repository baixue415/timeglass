/* ============================================================
   时璃 Timeglass · Electron 主进程
   窗口 / 托盘 / 定时调度 / 开机自启 / 全局热键 / IPC
   ============================================================ */
'use strict';
const { app, BrowserWindow, Tray, Menu, globalShortcut, ipcMain,
        dialog, nativeTheme, nativeImage, powerMonitor, screen, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const store = require('./lib/store');
const capture = require('./lib/capture');

/* IPC 通道对账：记录 ipcMain.handle 注册集合，启动时与 preload 实际调用核对
   （防止 meta:remove vs meta:delete 这类通道名静默失配） */
const ipcChannels = new Set();
{
  const origHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (ch, fn) => { ipcChannels.add(ch); return origHandle(ch, fn); };
}
function auditIpcChannels() {
  try {
    const src = fs.readFileSync(path.join(__dirname, 'preload.js'), 'utf8');
    const used = new Set([...src.matchAll(/invoke\(\s*'([^']+)'/g)].map(m => m[1]));
    const missing = [...used].filter(c => !ipcChannels.has(c));
    const unused = [...ipcChannels].filter(c => !used.has(c));
    if (missing.length) console.error('[ipc-audit] ✗ preload 调用了未注册通道（会静默失败）:', missing);
    if (unused.length) console.warn('[ipc-audit] 已注册但 preload 未调用:', unused);
    if (!missing.length && !unused.length) console.log('[ipc-audit] ✓ 通道全部一致（' + ipcChannels.size + ' 个）');
  } catch (e) { console.error('[ipc-audit] failed:', e.message); }
}
const transcode = require('./lib/transcode');
const activity = require('./lib/activity');
const activityStore = require('./lib/activityStore');

let win = null;
let trayWin = null;
let tray = null;
let quitting = false;

const gotHiddenFlag = process.argv.includes('--hidden');
let pausedUntil = 0;     // 0 = 未暂停；否则为恢复时间戳
let schedulerTimer = null;
let nextShotAt = 0;

/* ---------------- 主窗口 ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 1080,
    minHeight: 680,
    frame: false,
    show: !gotHiddenFlag && !store.getSettings().app.silentToTray,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 把渲染层的报错转发到终端，方便排查
  win.webContents.on('console-message', (e, level, message, line, sourceId) => {
    if (String(level).toLowerCase().includes('error') || String(level) === '3') {
      console.log('[renderer:error]', message, '@', sourceId, ':' + line);
    }
  });
  win.on('maximize', () => win.webContents.send('tg-maximize', true));
  win.on('unmaximize', () => win.webContents.send('tg-maximize', false));
  win.on('close', e => {
    const st = store.getSettings();
    if (!quitting && st.app.minimizeToTray) {
      e.preventDefault();
      win.hide();
    }
  });
}

/* ---------------- 托盘 ---------------- */
function trayIconPath() {
  return path.join(__dirname, 'assets', 'tray.png');
}
function createTray() {
  if (!fs.existsSync(trayIconPath())) return null;
  tray = new Tray(trayIconPath());
  tray.setToolTip('时璃 Timeglass');
  tray.on('click', () => toggleTrayPanel());
  tray.on('right-click', () => {
    const menu = Menu.buildFromTemplate([
      { label: '打开主界面', click: () => { showMain(); } },
      { label: '立即截屏', click: () => doCapture('manual') },
      { type: 'separator' },
      { label: paused() ? '恢复采集' : '暂停采集', click: () => togglePause() },
      { label: '退出', click: () => { quitting = true; app.quit(); } }
    ]);
    tray.popUpContextMenu(menu);
  });
  return tray;
}
function toggleTrayPanel() {
  if (trayWin && !trayWin.isDestroyed()) {
    if (trayWin.isVisible()) trayWin.hide();
    else showTrayPanel();
  } else {
    showTrayPanel();
  }
}
function showTrayPanel() {
  if (!trayWin || trayWin.isDestroyed()) {
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const W = 360, H = 480;
    trayWin = new BrowserWindow({
      width: W, height: H,
      x: Math.min(display.bounds.x + display.bounds.width - W - 12, Math.max(display.bounds.x + 12, cursor.x - W / 2)),
      y: display.bounds.y + display.workArea.height - H - 12,
      frame: false, resizable: false, movable: false, skipTaskbar: true,
      alwaysOnTop: true, show: false, focusable: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true, nodeIntegration: false
      }
    });
    trayWin.loadFile(path.join(__dirname, 'tray.html'));
    trayWin.on('blur', () => { if (trayWin && !trayWin.isDestroyed()) trayWin.hide(); });
  }
  trayWin.show();
  trayWin.focus();
}

function showMain() {
  if (!win || win.isDestroyed()) createWindow();
  win.show();
  win.focus();
}

/* ---------------- 调度 ---------------- */
function paused() { return pausedUntil !== 0 && Date.now() < pausedUntil; }
function pauseFor(ms) { pausedUntil = Date.now() + ms; resetScheduler(); }
function resume() { pausedUntil = 0; resetScheduler(); }
function togglePause() { paused() ? resume() : pauseFor(30 * 60000); }

async function doCapture(reason) {
  try {
    if (reason === 'timer' && lockPaused && store.getSettings().capture.pauseOnLock) {
      return { skipped: 'lock' };
    }
    if (reason === 'timer' && idlePaused) {
      return { skipped: 'idle' };
    }
    const r = await capture.captureNow(reason);
    if (r.ok) {
      broadcast('tg-shot-taken', r.rec);
      // 托盘气泡提示（手动触发时才打扰）
      if (tray && reason === 'manual') tray.displayBalloon({ title: '时璃', content: '截图已保存（时间与窗口信息写入元数据）' });
    }
    return r;
  } catch (e) {
    console.warn('capture failed', e);
    return { error: String(e.message || e) };
  }
}

function scheduleNext() {
  if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null; }
  const st = store.getSettings();
  if (!st.capture.enabled) { nextShotAt = 0; broadcast('tg-status', statusPayload()); return; }
  const min = Math.max(1, st.capture.intervalMin) * 60000;
  nextShotAt = Date.now() + min;
  broadcast('tg-status', statusPayload()); // 立即同步新倒计时，避免截图/改规则后状态栏卡在 0 秒
  if (paused()) return;   // 暂停期间不排下一次，等 resume 触发 resetScheduler
  schedulerTimer = setTimeout(async () => {
    schedulerTimer = null;
    await doCapture('timer');
    capture.enforceRetention();
    scheduleNext();
  }, min);
}
function resetScheduler() {
  if (store.getSettings().capture.enabled) scheduleNext();
  else if (schedulerTimer) { clearTimeout(schedulerTimer); schedulerTimer = null; nextShotAt = 0; }
  broadcast('tg-status', statusPayload());
}

function broadcast(ch, payload) {
  for (const w of [win, trayWin]) {
    if (w && !w.isDestroyed()) w.webContents.send(ch, payload);
  }
}

function statusPayload() {
  return {
    paused: paused(),
    pausedUntil,
    idlePaused,
    nextShotAt,
    enabled: store.getSettings().capture.enabled,
    intervalMin: store.getSettings().capture.intervalMin
  };
}
transcode.onChange(() => broadcast('tg-transcode', transcode.state()));

/* ---------------- IPC ---------------- */
ipcMain.handle('settings:get', () => store.getSettings());
ipcMain.handle('settings:save', (e, patch) => {
  const s = store.saveSettings(patch);
  if (patch.app) {
    try {
      app.setLoginItemSettings({
        openAtLogin: !!s.app.autostart,
        args: ['--hidden']
      });
    } catch (err) { console.warn('setLoginItemSettings', err); }
  }
  // 任何采集相关设置变化都立即重新调度（间隔/范围/启用等），实现热更新
  if (patch.capture) resetScheduler();
  broadcast('tg-settings-changed', s);
  return s;
});
ipcMain.handle('settings:reset', () => { const s = store.resetSettings(); resetScheduler(); return s; });

ipcMain.handle('capture:now', () => doCapture('manual'));
ipcMain.handle('capture:pauseFor', (e, ms) => { pauseFor(ms); return statusPayload(); });
ipcMain.handle('capture:resume', () => { resume(); return statusPayload(); });
ipcMain.handle('capture:status', () => statusPayload());

ipcMain.handle('meta:list', (e, q) => {
  const shots = store.shots();
  const filtered = shots.filter(s => {
    if (q.day) {
      // 本地日期比较（toISOString 是 UTC，会差一天，与前端 dayKey 不一致）
      const d = new Date(s.ts);
      const key = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
      if (key !== q.day) return false;
    }
    if (q.app && !(s.app || '').toLowerCase().includes(String(q.app).toLowerCase())) return false;
    if (q.title && !(s.title || '').toLowerCase().includes(String(q.title).toLowerCase())) return false;
    if (q.fromTs && s.ts < q.fromTs) return false;
    if (q.toTs && s.ts > q.toTs) return false;
    return true;
  }).sort((a, b) => b.ts - a.ts);
  return filtered.slice(0, q.limit || 500);
});
ipcMain.handle('meta:stats', () => store.stats());
// 键鼠活跃度查询（按天，缺省今天）：{ "HH:MM": {k,c,m} }
ipcMain.handle('activity:day', (e, day) => {
  let d = day;
  if (!d) {
    const n = new Date();
    d = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0') + '-' + String(n.getDate()).padStart(2, '0');
  }
  return activityStore.getDay(d);
});
// 月度活跃度汇总（供日历热力）：{ "YYYY-MM-DD": {k,c,m} }
ipcMain.handle('activity:month', (e, month) => {
  let m = month;
  if (!m) {
    const n = new Date();
    m = n.getFullYear() + '-' + String(n.getMonth() + 1).padStart(2, '0');
  }
  return activityStore.monthSummary(m);
});
// 当天实时活跃度（已落盘 + 内存待落盘），供界面实时跳变
ipcMain.handle('activity:today', () => {
  const d = new Date();
  const day = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const merged = { ...activityStore.getDay(day) };
  const live = (activity.snapshot()[day]) || {};
  for (const [mm, v] of Object.entries(live)) {
    const cur = merged[mm] || { k: 0, c: 0, m: 0 };
    cur.k += v.k || 0; cur.c += v.c || 0; cur.m += v.m || 0;
    merged[mm] = cur;
  }
  return merged;
});
/* 路径安全：截图类 IPC 只允许操作存储目录内的文件 */
function shotRoot() { try { return path.resolve(store.getSettings().storage.dir); } catch (e) { return null; } }
function safeShotPath(file) {
  const root = shotRoot();
  if (!root || typeof file !== 'string' || !file) return null;
  const p = path.resolve(file);
  return (p === root || p.startsWith(root + path.sep)) ? p : null;
}

/* 缩略图：nativeImage 缩放 + 磁盘缓存（key 含 mtime，原图变更自动失效） */
const THUMB_DIR = path.join(app.getPath('userData'), 'data', 'thumbs');
ipcMain.handle('meta:thumb', (e, payload) => {
  try {
    const file = safeShotPath(payload && payload.file);
    if (!file) return null;
    const maxW = Math.min(Math.max(Math.round(+payload.maxW) || 360, 120), 720);
    const st = fs.statSync(file);
    const key = crypto.createHash('md5').update(file + '|' + st.mtimeMs + '|' + maxW).digest('hex') + '.jpg';
    if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });
    const cached = path.join(THUMB_DIR, key);
    let buf;
    if (fs.existsSync(cached)) buf = fs.readFileSync(cached);
    else {
      const img = nativeImage.createFromPath(file);
      if (img.isEmpty()) return null;
      const w = img.getSize().width;
      buf = (w > maxW ? img.resize({ width: maxW }) : img).toJPEG(72);
      fs.writeFileSync(cached, buf);
    }
    return 'data:image/jpeg;base64,' + buf.toString('base64');
  } catch (err) { return null; }
});
ipcMain.handle('meta:image', (e, file) => {
  const p = safeShotPath(file);
  if (!p) return null;
  try { return 'data:image/png;base64,' + fs.readFileSync(p).toString('base64'); }
  catch (err) { return null; }
});
ipcMain.handle('meta:delete', (e, id) => {
  const s = store.shots().find(x => x.id === id);
  if (s) {
    const p = safeShotPath(s.file);
    if (p && fs.existsSync(p)) { try { fs.unlinkSync(p); } catch (e2) {} }
  }
  store.removeShot(id);
  broadcast('tg-shot-deleted', id);
  return true;
});
ipcMain.handle('shell:openPath', (e, p) => shell.openPath(safeShotPath(p) || ''));
ipcMain.handle('shell:showInFolder', (e, p) => { const q = safeShotPath(p); if (q) shell.showItemInFolder(q); return true; });

ipcMain.handle('dialog:pickVideo', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: '视频', extensions: ['mp4', 'mkv', 'mov', 'avi', 'webm', 'flv', 'ts', 'wmv'] }], properties: ['openFile'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:pickStorageDir', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:pickWallpaper', async () => {
  const r = await dialog.showOpenDialog(win, { filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }], properties: ['openFile'] });
  if (r.canceled || !r.filePaths[0]) return null;
  try {
    const b = fs.readFileSync(r.filePaths[0]);
    const ext = path.extname(r.filePaths[0]).slice(1).toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    return 'data:' + mime + ';base64,' + b.toString('base64');
  } catch (e) { return null; }
});

ipcMain.handle('system:prefersColorScheme', () => nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
ipcMain.handle('system:probeFfmpeg', async () => (await transcode.which('ffmpeg')) || null);

ipcMain.handle('transcode:add', (e, params) => transcode.addJob(params));
ipcMain.handle('transcode:cancel', (e, id) => transcode.cancelJob(id));
ipcMain.handle('transcode:clear', () => { transcode.clearDone(); return true; });
ipcMain.handle('transcode:state', () => transcode.state());
ipcMain.handle('transcode:preview', (e, params) => transcode.previewCommand(params));
ipcMain.handle('transcode:presets', () => transcode.PRESETS);
ipcMain.handle('transcode:probe', (e, p) => transcode.probe(p));

ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });
ipcMain.handle('app:showMain', () => showMain());
ipcMain.handle('win:minimize', () => win?.minimize());
ipcMain.handle('win:close', () => win?.hide()); // 关闭=最小化到托盘（受设置控制，主窗 close 事件处理）
ipcMain.handle('win:toggleMaximize', () => {
  if (!win) return false;
  win.isMaximized() ? win.unmaximize() : win.maximize();
  return win.isMaximized();
});
ipcMain.handle('win:isMaximized', () => !!win?.isMaximized());

/* ---------------- 生命周期 ---------------- */
let lockPaused = false;
let idlePaused = false;
let idleTimer = null;
let activityFlushTimer = null;

// 把采集到的按分钟活跃度落盘
function flushActivity() {
  const data = activity.drain();
  if (data && Object.keys(data).length) activityStore.append(data);
}

// 空闲检测：键鼠不活跃超过阈值则标记 idlePaused（调度器保持运行，仅在采集时跳过）
function checkIdle() {
  const st = store.getSettings();
  if (!st.capture.pauseOnIdle) {
    if (idlePaused) { idlePaused = false; broadcast('tg-status', statusPayload()); }
    return;
  }
  const idleSec = powerMonitor.getSystemIdleTime(); // 秒
  const threshold = (st.capture.idleMinutes || 15) * 60;
  const nowIdle = idleSec >= threshold;
  if (nowIdle !== idlePaused) {
    idlePaused = nowIdle;
    broadcast('tg-status', statusPayload());
  }
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  auditIpcChannels();

  const st = store.getSettings();
  try {
    app.setLoginItemSettings({ openAtLogin: !!st.app.autostart, args: ['--hidden'] });
  } catch (e) {}

  registerHotkey(st.app.hotkey || 'Control+Alt+P');
  if (st.capture.enabled) scheduleNext();
  idleTimer = setInterval(checkIdle, 15000);
  checkIdle(); // 启动时立即同步一次空闲状态

  // 键鼠活跃度采集（全局钩子），按分钟聚合，定时落盘
  activity.start();
  activityStore.cleanup(store.getSettings().storage.keepDays || 90);
  activityFlushTimer = setInterval(flushActivity, 60000);

  powerMonitor.on('lock-screen', () => { lockPaused = true; broadcast('tg-status', statusPayload()); });
  powerMonitor.on('unlock-screen', () => { lockPaused = false; broadcast('tg-status', statusPayload()); });

  nativeTheme.on('updated', () => broadcast('tg-theme-changed', nativeTheme.shouldUseDarkColors ? 'dark' : 'light'));
});

function registerHotkey(accel) {
  try {
    globalShortcut.unregisterAll();
    globalShortcut.register(accel, () => {
      togglePause();
      if (tray) tray.displayBalloon({ title: '时璃', content: paused() ? '采集已暂停（Ctrl+Alt+P 恢复）' : '采集已恢复' });
    });
  } catch (e) { console.warn('hotkey register failed', e); }
}
ipcMain.handle('app:rehotkey', (e, accel) => { registerHotkey(accel); return true; });

app.on('window-all-closed', () => { /* 托盘常驻，不退出 */ });
app.on('before-quit', () => { try { if (idleTimer) clearInterval(idleTimer); if (activityFlushTimer) clearInterval(activityFlushTimer); activity.stop(); flushActivity(); globalShortcut.unregisterAll(); } catch (e) {} });
app.on('will-quit', () => { try { if (idleTimer) clearInterval(idleTimer); if (activityFlushTimer) clearInterval(activityFlushTimer); activity.stop(); flushActivity(); globalShortcut.unregisterAll(); } catch (e) {} });
