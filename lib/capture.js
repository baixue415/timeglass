/* 时璃 · 定时截屏 + 前台窗口元数据 + 去重 + 保留策略 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { desktopCapturer, screen } = require('electron');
const store = require('./store');

let lastHash = null;
let lastShotAt = 0;

/* ---- 前台窗口信息（PowerShell · user32）----
   返回 { pid, app, title, fullscreen }，全屏 = 前台窗口铺满主显示器 */
const PS_FOREGROUND = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type @"
using System;using System.Runtime.InteropServices;using System.Text;
public class W {
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
 public struct RECT { public int L; public int T; public int R; public int B; }
}
"@
$h=[W]::GetForegroundWindow()
$sb=New-Object System.Text.StringBuilder 512
[void][W]::GetWindowText($h,$sb,512)
$p=[uint32]0
[void][W]::GetWindowThreadProcessId($h,[ref]$p)
$r=New-Object W+RECT
[void][W]::GetWindowRect($h,[ref]$r)
$proc=""
try { $proc=(Get-Process -Id $p -ErrorAction Stop).ProcessName } catch {}
$m=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds
@{pid=$p; app=$proc; title=$sb.ToString(); L=$r.L; T=$r.T; R=$r.R; B=$r.B; MW=$m.Width; MH=$m.Height} | ConvertTo-Json -Compress`;

let psCache = null;
function runPS(script) {
  return new Promise((resolve) => {
    const { spawn } = require('child_process');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', () => resolve({ out, err }));
    child.on('error', e => resolve({ out: '', err: String(e) }));
    setTimeout(() => { try { child.kill(); } catch (e) {} }, 4000).unref?.();
  });
}

async function foregroundInfo() {
  if (!psCache) psCache = PS_FOREGROUND;
  const { out } = await runPS(psCache);
  try {
    const j = JSON.parse(out.trim());
    return {
      pid: j.pid || 0,
      app: j.app || '',
      title: j.title || '',
      fullscreen: !!(j.MW && j.MH && j.L <= 0 && j.T <= 0 && j.R >= j.MW - 1 && j.B >= j.MH - 1)
    };
  } catch (e) { return { pid: 0, app: '', title: '', fullscreen: false }; }
}

/* ---- 截屏 ---- */
// 当前活动显示器：鼠标所在屏幕（多屏下截取用户正在操作的屏，而非固定主屏）
function activeDisplay() {
  try {
    const pt = screen.getCursorScreenPoint();
    return screen.getDisplayNearestPoint(pt);
  } catch (e) {
    return screen.getPrimaryDisplay();
  }
}

async function captureScreen() {
  const display = activeDisplay();
  const sc = display.scaleFactor || 1;
  const size = display.size;
  const thumb = { width: Math.round(size.width * sc), height: Math.round(size.height * sc) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: thumb });
  const src = sources.find(s => s.display_id === String(display.id)) || sources[0];
  if (!src) throw new Error('no screen source');
  return src.thumbnail; // NativeImage
}

/* ---- 采集主流程 ---- */
function dayDir(root) {
  const d = new Date();
  const name = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const dir = path.join(root, name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function inRange(now, start, end) {
  const toMin = s => { const [h, m] = (s || '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
  const cur = now.getHours() * 60 + now.getMinutes();
  const a = toMin(start), b = toMin(end);
  if (a === b) return true;
  if (a < b) return cur >= a && cur < b;
  return cur >= a || cur < b; // 跨零点
}

async function captureNow(reason) {
  const st = store.getSettings();
  const now = new Date();
  const cap = st.capture;

  // 采集范围外 / 排除应用（全天则跳过范围判断）
  if (!cap.allDay && !inRange(now, cap.rangeStart, cap.rangeEnd)) return { skipped: 'range' };
  const fg = cap.writeWindowMeta || cap.excludeApps?.length || cap.pauseOnFullscreen ? await foregroundInfo() : { app: '', title: '', fullscreen: false };
  if (cap.excludeApps && cap.excludeApps.some(a => a && fg.app.toLowerCase() === String(a).toLowerCase())) return { skipped: 'excluded', app: fg.app };
  if (cap.pauseOnFullscreen && fg.fullscreen) return { skipped: 'fullscreen', app: fg.app };

  // 截屏
  const img = await captureScreen();
  const buf = img.toPNG();
  if (!buf || buf.length < 1000) return { skipped: 'empty' };

  // 去重
  if (cap.dedupe) {
    const h = crypto.createHash('md5').update(buf).digest('hex');
    if (h === lastHash && Date.now() - lastShotAt < 30 * 60 * 1000) return { skipped: 'dedupe' };
    lastHash = h;
  }

  // 落盘：存储目录/日期/时间戳.png
  const dir = dayDir(st.storage.dir);
  const ts = now.getTime();
  const stamp = `${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const file = path.join(dir, `TG_${stamp}.png`);
  fs.writeFileSync(file, buf);

  // 元数据（只写库，画面保持干净）
  const rec = {
    id: crypto.randomUUID ? crypto.randomUUID() : 'id' + ts + Math.random().toString(16).slice(2),
    file, ts,
    w: img.getSize().width, h: img.getSize().height, size: buf.length,
    app: cap.writeWindowMeta ? fg.app : null,
    title: cap.writeWindowMeta ? fg.title : null
  };
  store.addShot(rec);
  lastShotAt = ts;
  return { ok: true, rec, reason };
}

/* ---- 保留策略：按天数 + 空间上限清理（含元数据） ---- */
function enforceRetention() {
  const st = store.getSettings();
  const keepDays = st.storage.keepDays || 0;
  const maxBytes = (st.storage.maxGB || 0) * 1024 ** 3;
  const shots = store.shots().slice();
  const now = Date.now();
  const removeIds = new Set();

  if (keepDays > 0) {
    for (const s of shots) {
      if (now - s.ts > keepDays * 864e5) removeIds.add(s.id);
    }
  }
  // 空间上限：从最旧开始删，直到低于上限
  let total = shots.reduce((a, s) => a + (s.size || 0), 0);
  if (maxBytes > 0) {
    const sorted = shots.filter(s => !removeIds.has(s.id)).sort((a, b) => a.ts - b.ts);
    for (const s of sorted) {
      if (total <= maxBytes) break;
      if (fs.existsSync(s.file)) {
        try { fs.unlinkSync(s.file); } catch (e) {}
        total -= (s.size || 0);
      }
      removeIds.add(s.id);
    }
  }
  for (const id of removeIds) {
    const s = shots.find(x => x.id === id);
    if (s && fs.existsSync(s.file)) { try { fs.unlinkSync(s.file); } catch (e) {} }
  }
  if (removeIds.size) {
    store.saveMeta({ shots: shots.filter(s => !removeIds.has(s.id)) });
  }
  return removeIds.size;
}

module.exports = { captureNow, enforceRetention, foregroundInfo, inRange };
