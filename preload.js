/* 时璃 · preload：渲染进程唯一入口（contextIsolation 开启） */
'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('api', {
  /* 设置 */
  settings: {
    get: () => invoke('settings:get'),
    save: patch => invoke('settings:save', patch),
    reset: () => invoke('settings:reset')
  },
  /* 采集 */
  capture: {
    now: () => invoke('capture:now'),
    pauseFor: ms => invoke('capture:pauseFor', ms),
    resume: () => invoke('capture:resume'),
    status: () => invoke('capture:status')
  },
  /* 元数据 */
  meta: {
    list: q => invoke('meta:list', q || {}),
    stats: () => invoke('meta:stats'),
    image: file => invoke('meta:image', file),
    remove: id => invoke('meta:remove', id)
  },
  /* 文件与系统 */
  dialog: {
    pickVideo: () => invoke('dialog:pickVideo'),
    pickStorageDir: () => invoke('dialog:pickStorageDir'),
    pickWallpaper: () => invoke('dialog:pickWallpaper')
  },
  system: {
    prefersColorScheme: () => invoke('system:prefersColorScheme'),
    probeFfmpeg: () => invoke('system:probeFfmpeg')
  },
  shell: {
    openPath: p => invoke('shell:openPath', p),
    showInFolder: p => invoke('shell:showInFolder', p)
  },
  /* 转码 */
  transcode: {
    add: p => invoke('transcode:add', p),
    cancel: id => invoke('transcode:cancel', id),
    clear: () => invoke('transcode:clear'),
    state: () => invoke('transcode:state'),
    preview: p => invoke('transcode:preview', p),
    presets: () => invoke('transcode:presets')
  },
  /* 应用与窗口 */
  app: {
    quit: () => invoke('app:quit'),
    showMain: () => invoke('app:showMain'),
    rehotkey: a => invoke('app:rehotkey', a)
  },
  win: {
    minimize: () => invoke('win:minimize'),
    close: () => invoke('win:close'),
    toggleMaximize: () => invoke('win:toggleMaximize')
  },
  /* 事件订阅（返回取消函数） */
  on: {
    status: fn => subscribe('tg-status', fn, () => invoke('capture:status')),
    shotTaken: fn => subscribe('tg-shot-taken', fn),
    shotDeleted: fn => subscribe('tg-shot-deleted', fn),
    settings: fn => subscribe('tg-settings-changed', fn),
    transcode: fn => subscribe('tg-transcode', fn, () => invoke('transcode:state')),
    theme: fn => subscribe('tg-theme-changed', fn),
    maximize: fn => subscribe('tg-maximize', fn, () => invoke('win:isMaximized'))
  }
});

function subscribe(ch, fn, refresh) {
  const listener = (e, payload) => fn(payload, e);
  ipcRenderer.on(ch, listener);
  if (refresh) refresh().then(v => { try { fn(v); } catch (err) {} }).catch(() => {});
  return () => ipcRenderer.removeListener(ch, listener);
}
