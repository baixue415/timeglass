/* 时璃 · 图形化 FFmpeg：参数构建 + 队列 + 进度解析 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const which = (bin) => {
  const isWin = process.platform === 'win32';
  const cmd = isWin ? 'where' : 'which';
  return new Promise(resolve => {
    require('child_process').exec(`${cmd} ${bin}`, (e, out) => resolve(e ? null : out.trim().split('\n')[0]));
  });
};

/* ---- 预设 ---- */
const PRESETS = {
  web:      { name: '网页通用 · 1080p', container: 'mp4', vcodec: 'libx264', mode: 'bitrate', bitrate: 2500, maxrate: 3, bufsize: 6, fps: 30, scale: '1920:1080', audio: 'aac', abitrate: 128 },
  save:     { name: '归档节省 · 720p', container: 'mp4', vcodec: 'libx264', mode: 'bitrate', bitrate: 1200, maxrate: 1.5, bufsize: 3, fps: 24, scale: '1280:720', audio: 'aac', abitrate: 96 },
  h265:     { name: 'H.265 高压缩', container: 'mp4', vcodec: 'libx265', mode: 'crf', crf: 28, fps: 0, scale: '', audio: 'aac', abitrate: 128 },
  original: { name: '仅转封装', container: 'mp4', vcodec: 'copy', mode: 'none', fps: 0, scale: '', audio: 'copy', abitrate: 0 }
};

const VC_NVENC = { libx264: 'h264_nvenc', libx265: 'hevc_nvenc', libvpx_vp9: '' };

/* ---- 参数构建 ---- */
function buildArgs(p) {
  // p: { input, output, container, vcodec, nvenc, mode, bitrate, maxrate, bufsize, crf, fps, scaleMode, scaleW/H/Pct, audio, abitrate, ss, to }
  const args = ['-hide_banner'];
  // 时间段截取：-ss 放 -i 前（input seek，重编码下同样精确且快很多）
  if (p.ss > 0) args.push('-ss', String(p.ss));
  args.push('-i', p.input);
  const vc = p.nvenc ? (VC_NVENC[p.vcodec] || p.vcodec) : p.vcodec;

  if (vc === 'copy') {
    args.push('-c', 'copy');
  } else {
    args.push('-c:v', vc);
    if (p.vcodec === 'libx265') args.push('-preset', p.nvenc ? 'p5' : 'medium');
    else if (vc.endsWith('_nvenc')) args.push('-preset', 'p5');
    else args.push('-preset', 'medium');

    if (p.mode === 'crf') {
      args.push(p.nvenc ? '-cq' : '-crf', String(p.crf));
      if (p.nvenc) args.push('-b:v', '0');
    } else if (p.mode === 'bitrate') {
      args.push('-b:v', `${p.bitrate}k`);
      if (p.maxrate) args.push('-maxrate', `${p.maxrate * 1000}k`);
      if (p.bufsize) args.push('-bufsize', `${p.bufsize * 1000}k`);
    }
    if (p.fps > 0) args.push('-r', String(p.fps));
    const vf = [];
    if (p.scaleMode === 'size' && p.scaleW && p.scaleH) vf.push(`scale=${p.scaleW}:${p.scaleH}`);
    else if (p.scaleMode === 'percent' && p.scalePct && p.scalePct !== 100) vf.push(`scale=iw*${p.scalePct / 100}:ih*${p.scalePct / 100}`);
    if (vf.length) args.push('-vf', vf.join(','));
  }

  args.push('-c:a', p.audio === 'copy' ? 'copy' : (p.audio || 'aac'));
  if (p.audio !== 'copy' && p.abitrate > 0) args.push('-b:a', `${p.abitrate}k`);
  // 截取段时长：-t = to - ss。input seek 下输出时间轴从 0 计时，用 -to 会把 ss 段也多算进去
  if (p.to > (p.ss || 0)) args.push('-t', String(+(p.to - p.ss).toFixed(3)));
  if (p.container === 'mp4') args.push('-movflags', '+faststart');
  args.push('-y', p.output);
  return args;
}

function previewCommand(p) {
  // buildArgs 返回原始参数数组（无引号），这里只给含空格的（路径）加引号
  return 'ffmpeg ' + buildArgs(p).map(a => {
    if (/\s/.test(a)) return '"' + a.replace(/"/g, '\\"') + '"';
    return a;
  }).join(' ');
}

/* ---- 时长探测（ffmpeg stderr 的 Duration 行） ---- */
function parseDuration(line) {
  const m = line.match(/Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/);
  if (!m) return 0;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 100;
}

/* ---- 队列 ---- */
let queue = [];        // { id, params, status: waiting|running|done|error|canceled, progress, speed, outSize }
let running = null;
let ffmpegPath = null;
const listeners = new Set();
function emit() { listeners.forEach(fn => { try { fn(state()); } catch (e) {} }); }
function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function state() {
  return {
    // 只挑可序列化字段（child 是 ChildProcess，不能过 IPC）
    queue: queue.map(q => ({
      id: q.id, params: q.params, status: q.status,
      progress: q.progress, speed: q.speed, outSize: q.outSize,
      error: q.error, addedAt: q.addedAt
    })),
    running: running ? running.id : null
  };
}

function defaultOutput(input, container) {
  const dir = path.dirname(input);
  const ext = path.extname(input).slice(1) || container;
  const base = path.basename(input, path.extname(input));
  const safe = base.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
  return path.join(dir, `${safe}.timeglass.${container}`);
}

function fmtBytes(n) { return n > 1024 ** 2 ? (n / 1024 ** 2).toFixed(1) + ' MB' : Math.round(n / 1024) + ' KB'; }

async function next() {
  if (running) return;
  const item = queue.find(q => q.status === 'waiting');
  if (!item) return;
  running = item.id;
  item.status = 'running';
  item.progress = 0;
  item.speed = '';
  emit();

  if (!ffmpegPath) ffmpegPath = await which('ffmpeg');
  if (!ffmpegPath) {
    item.status = 'error';
    item.error = '未找到 ffmpeg，请安装并加入 PATH（gyan.dev full build 即可）';
    running = null;
    emit();
    next();
    return;
  }

  const args = buildArgs(item.params);
  const child = spawn(ffmpegPath, ['-hide_banner', '-progress', 'pipe:1', ...args.slice(1)], { windowsHide: true });
  item.child = child;
  // 截取段时长优先用于进度（stderr 的 Duration 是全片时长）
  let total = (item.params.to > (item.params.ss || 0)) ? item.params.to - (item.params.ss || 0) : 0;
  let outSize = 0;

  child.stderr.on('data', d => {
    const s = d.toString();
    if (!total) { const t = parseDuration(s); if (t > 0) total = t; }
  });
  child.stdout.on('data', d => {
    const s = d.toString();
    const m = s.match(/out_time_us=(\d+)/) || s.match(/out_time=(\d+):(\d+):(\d+)/);
    if (m) {
      const sec = m.length === 2 ? (+m[1]) / 1e6 : (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
      if (total > 0) item.progress = Math.min(100, Math.round(sec / total * 100));
      const sp = s.match(/speed=\s*([\d.]+)x/);
      if (sp) item.speed = sp[1] + 'x';
      emit();
    }
  });
  child.on('error', e => {
    item.status = 'error';
    item.error = String(e.message || e);
    running = null;
    emit();
    next();
  });
  child.on('close', (code) => {
    try { outSize = fs.existsSync(item.params.output) ? fs.statSync(item.params.output).size : 0; } catch (e) {}
    if (item.status === 'canceled') {
      try { if (fs.existsSync(item.params.output)) fs.unlinkSync(item.params.output); } catch (e) {}
    } else if (code === 0) {
      item.status = 'done';
      item.progress = 100;
      item.outSize = fmtBytes(outSize);
    } else {
      item.status = 'error';
      item.error = 'ffmpeg 退出码 ' + code;
    }
    running = null;
    emit();
    next();
  });
}

/* 探测文件：大小 + 时长（跑一次 ffmpeg -i，读 stderr 的 Duration） */
async function probe(input) {
  let size = 0;
  try { size = fs.statSync(input).size; } catch (e) {}
  if (!ffmpegPath) ffmpegPath = await which('ffmpeg');
  if (!ffmpegPath) return { size, duration: 0 };
  return new Promise(resolve => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-i', input], { windowsHide: true });
    let buf = '';
    child.stderr.on('data', d => { buf += d.toString(); if (buf.length > 30000) buf = buf.slice(-30000); });
    child.on('close', () => resolve({ size, duration: parseDuration(buf) }));
    child.on('error', () => resolve({ size, duration: 0 }));
  });
}

function addJob(params) {
  const id = 'job_' + Date.now() + '_' + Math.random().toString(16).slice(2, 6);
  const item = {
    id,
    params: { ...params, output: params.output || defaultOutput(params.input, params.container) },
    status: 'waiting',
    progress: 0,
    speed: '',
    addedAt: Date.now()
  };
  queue.push(item);
  emit();
  next();
  return item;
}
function cancelJob(id) {
  const item = queue.find(q => q.id === id);
  if (!item) return false;
  if (item.status === 'running' && item.child) {
    item.status = 'canceled';
    try { item.child.kill(); } catch (e) {}
  } else {
    queue = queue.filter(q => q.id !== id);
  }
  emit();
  return true;
}
function clearDone() {
  queue = queue.filter(q => q.status === 'waiting' || q.status === 'running');
  emit();
}

module.exports = { PRESETS, buildArgs, previewCommand, addJob, cancelJob, clearDone, state, onChange, defaultOutput, which, probe };
