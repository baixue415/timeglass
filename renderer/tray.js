/* 时璃 · 托盘浮出面板逻辑 */
(() => {
'use strict';
const api = window.api;
const $ = s => document.querySelector(s);

const st = {
  settings: null,
  stats: null,
  cap: null
};

function render() {
  if (!st.cap) return; // 防御：状态缺失时保持现状
  const paused = st.cap?.paused;
  const idle = st.cap?.idlePaused;
  $('#status-row').classList.toggle('paused', !!(paused || idle));
  $('#sub').textContent = paused ? '采集已暂停' : (idle ? '空闲暂停 · 键鼠不活跃' : '采集运行中');
  const left = paused ? Math.max(0, st.cap.pausedUntil - Date.now()) : Math.max(0, (st.cap?.nextShotAt || 0) - Date.now());
  const sec = Math.ceil(left / 1000);
  const m = Math.floor(sec / 60), s = sec % 60;
  $('#next').textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  $('#resume').classList.toggle('pri', !!paused);
  $('#st-today').textContent = st.stats?.todayCount ?? 0;
  $('#st-week').textContent = st.stats?.weekCount ?? 0;
  $('#st-total').textContent = st.stats?.total ?? 0;
  $('#auto-lab').textContent = st.settings?.app?.autostart ? '已开启' : '未开启';
  $('#hotkey-lab').textContent = (st.settings?.app?.hotkey || 'Control+Alt+P').replace('Control+', 'Ctrl+').replace('Alt+', 'Alt+');
}

async function boot() {
  st.settings = await api.settings.get();
  st.stats = await api.meta.stats();
  // 明暗跟随系统（壁纸取色主题作用于主窗口）
  const scheme = await api.system.prefersColorScheme();
  document.body.classList.toggle('light', scheme === 'light');
  render();
  api.on.status(c => { st.cap = c; render(); });
  api.on.settings(s => { st.settings = s; render(); });
  api.on.shotTaken(() => { api.meta.stats().then(v => { st.stats = v; render(); }); });
  api.on.theme(() => {
    api.system.prefersColorScheme().then(s => document.body.classList.toggle('light', s === 'light'));
  });

  // 每秒刷新倒计时（托盘面板是独立窗口，没有主窗口那样的 setInterval，需自己刷）
  setInterval(render, 1000);

  $('#p30').onclick = () => api.capture.pauseFor(30 * 60000).then(render);
  $('#p60').onclick = () => api.capture.pauseFor(60 * 60000).then(render);
  $('#pnight').onclick = async () => {
    const t = new Date(); t.setHours(24, 0, 0, 0);
    await api.capture.pauseFor(t.getTime() - Date.now());
    render();
  };
  $('#resume').onclick = () => api.capture.resume().then(render);
  $('#now').onclick = async () => {
    const r = await api.capture.now();
    $('#sub').textContent = r.ok ? '截图已保存' : (r.skipped ? '跳过（' + r.skipped + '）' : '失败');
    st.stats = await api.meta.stats();
    render();
  };
  $('#open-main').onclick = () => api.app.showMain();
  $('#open-dir').onclick = () => api.shell.openPath(st.settings.storage.dir);
  $('#quit').onclick = () => api.app.quit();
}
document.addEventListener('DOMContentLoaded', boot);
})();
