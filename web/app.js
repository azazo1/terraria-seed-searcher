/* 步骤切换, 素材导入和搜索状态. */
import { $, frameName, request } from './editor-core.js';
import { migrateParam } from './frame-schema.js';
import { bindSearchParameters } from './search-controls.js';
import { bindObservationTransfer } from './observation-transfer.js';
import { SearchSession } from './gpu/search-session.js';
import { renderSearchProgress } from './search-progress.js';
const labels = {
  import: ['导入主播截图', '导入原始截图, 然后逐张标定方块网格.'],
  grid: ['网格标定', '左键选第一条, 右键选第二条. Ctrl 拖动已选线平移相位, 左侧可调整间隔格数.'],
  calib: ['图片拼接', '使用已标定的网格移动和拼接图片, 锁定位置以防误拖.'],
  mark: ['标注地表', '点击或拖动标注. 自动继承网格标定和图片拼接.'],
  search: ['粗筛搜索', '使用已保存的最新观测进行搜索.'],
  candidates: ['查看候选', '查看搜索产出的候选记录.']
};
let active = 'import', state = null, switching = false, polling = false, uploading = false, transferring = false, startingSearch = false;
let frameKey = '', candidateKey = '', lastRun = false, stateRequest = 0, selectedTaskId = '', taskListKey = '';
const editors = new Map();
const searchParameters = bindSearchParameters();
const browserSearch = new SearchSession(() => {
  if (state) renderState(state);
  if (browserMode()) { $('log').textContent = browserSearch.messages.join('\n') || '浏览器搜索尚未启动.'; if (active === 'candidates') loadCandidates(true).catch(error => toast(error.message, true)); }
});
const browserMode = () => $('search-backend').value === 'webgpu';
const candidateSize = st => st?.sweep?.candidate_bytes?.[$('search-backend').value] ?? st?.sweep?.candidates;
const selectedTask = st => st?.tasks?.find(task => task.id === selectedTaskId);
const taskQuery = () => selectedTaskId ? '&task=' + encodeURIComponent(selectedTaskId) : '';
const candidateVersion = st => selectedTask(st)?.version ?? String(st?.sweep?.candidate_versions?.[$('search-backend').value] ?? candidateSize(st));
let loadingCandidates = false;
const webGpuSupported = !!globalThis.navigator?.gpu && !!globalThis.isSecureContext;
$('search-backend').value = webGpuSupported ? 'webgpu' : 'cuda';
$('search-backend').onchange = () => { selectedTaskId = state?.tasks?.find(task => task.backend === $('search-backend').value)?.id || ''; if (state) renderState(state); loadLog().catch(error => toast(error.message, true)); candidateKey = ''; if (active === 'candidates') loadCandidates(true).catch(error => toast(error.message, true)); };
$('search-task').onchange = () => {
  selectedTaskId = $('search-task').value; const task = selectedTask(state);
  if (task) $('search-backend').value = task.backend;
  candidateKey = ''; if (state) renderState(state); loadLog().catch(error => toast(error.message, true));
  if (active === 'candidates') loadCandidates(true).catch(error => toast(error.message, true));
};
$('download-browser-candidates').onclick = async () => {
  try {
    const rows = browserSearch.taskId === selectedTaskId ? browserSearch.lines() : (await request('/api/candidates?backend=webgpu&limit=2000' + taskQuery())).rows;
    browserSearch.download(rows);
  } catch (error) { toast('下载失败: ' + error.message, true); }
};
addEventListener('beforeunload', event => { if (browserSearch.running) { event.preventDefault(); event.returnValue = ''; } });
bindObservationTransfer({
  run: transferObservation,
  exportData: async () => {
    if (state.observed?.source !== 'import' && state.marks?.columns && calibrationCurrent()) {
      await ensureEditor('mark'); await editors.get('mark').iframe.contentWindow.editorBridge.flush();
    }
    return request('/api/observation');
  },
  importData: observation => request('/api/observation', observation),
  onError: toast
});
async function transferObservation(operation) {
  if (browserSearch.running || startingSearch) throw new Error('请先停止或等待搜索准备完成, 再导入或导出观测.');
  if (switching || uploading) throw new Error('请等待当前操作完成.');
  switching = transferring = true; document.body.setAttribute('aria-busy', 'true');
  for (const id of ['export-observation', 'import-observation', 'start']) $(id).disabled = true;
  try {
    // 先结束旧编辑器的保存, 防止其延迟请求覆盖随后导入的最终观测.
    for (const editor of editors.values()) {
      await editor.loaded; await editor.iframe.contentWindow.editorBridge.flush();
    }
    await refreshState(); return await operation();
  } finally {
    switching = transferring = false; document.body.removeAttribute('aria-busy');
    try { await refreshState(); } catch (error) { toast('无法更新状态: ' + error.message, true); }
  }
}
function toast(message, error = false) {
  const container = $('app-notice'); container.hidden = !message; container.classList.toggle('error', error); container.replaceChildren();
  if (!message) return;
  const span = document.createElement('span'); span.textContent = message;
  const close = document.createElement('button'); close.textContent = '关闭'; close.onclick = () => { container.hidden = true; }; container.append(span, close);
}
function editorKey(tab) {
  const geometry = state?.param?.frames?.map(({ id, src, x, y, scale, tile, tileY, phaseX, phaseY, on }) => ({ id, src, x, y, scale, tile, tileY, phaseX, phaseY, on }));
  return JSON.stringify([state?.frames, tab === 'mark' ? geometry : state?.param?.frames]);
}
function calibrationCurrent() {
  const names = state?.frames || [], savedFrames = state?.param?.frames || [];
  return names.length > 0 && names.length === savedFrames.length && savedFrames.every(f => names.includes(frameName(f.src)));
}
async function flushCurrent() {
  const editor = editors.get(active);
  if (!editor) return;
  await editor.loaded;
  if (!editor.iframe.contentWindow.editorBridge) throw new Error('编辑器未能加载, 当前步骤尚未保存. 请刷新后重试.');
  await editor.iframe.contentWindow.editorBridge.flush();
}
async function ensureEditor(tab) {
  let editor = editors.get(tab); const key = editorKey(tab);
  if (editor && editor.key === key) return editor.loaded;
  if (editor) editor.iframe.remove();
  const iframe = document.createElement('iframe'); iframe.title = labels[tab][0]; iframe.src = `/web/${tab === 'grid' ? 'grid' : tab === 'calib' ? 'calib' : 'mark'}.html?embedded=1`;
  const loaded = new Promise((resolve, reject) => { iframe.onload = resolve; iframe.onerror = () => reject(new Error('编辑器加载失败')); });
  editor = { iframe, key, loaded }; editors.set(tab, editor); $('pane-' + tab).replaceChildren(iframe); await loaded;
}
async function switchTab(tab, { updateHash = true } = {}) {
  if (!labels[tab] || switching || uploading) return;
  switching = true;
  document.body.setAttribute('aria-busy', 'true');
  $('page-hint').textContent = '正在保存当前进度并载入下一步骤...';
  try {
    await flushCurrent(); await refreshState();
    if (editors.has(active)) editors.get(active).key = editorKey(active);
    if (['grid', 'calib'].includes(tab) && !state.frames.length) { toast('请先导入至少一张截图.'); return; }
    if (tab === 'calib' && !calibrationCurrent()) { toast('请先进入网格标定步骤. 各张图片的标定会自动传到拼接步骤.'); return; }
    if (tab === 'mark' && (!calibrationCurrent() || !state.param?.frames?.some(f => f.on !== false))) { toast('请先标定网格, 再在图片拼接步骤中显示至少一张图片.'); return; }
    if (['search', 'candidates'].includes(tab) && state.marks?.columns && state.observed?.source !== 'import') {
      if (!calibrationCurrent()) { toast('截图列表已变化, 请先进入网格标定步骤确认.'); return; }
      // 跨过标注 Tab 时也先继承最新格宽并生成观测, 避免搜索旧参数.
      await ensureEditor('mark');
      await editors.get('mark').iframe.contentWindow.editorBridge.flush();
      await refreshState();
    }
    for (const key of Object.keys(labels)) {
      $('pane-' + key).hidden = key !== tab;
      const button = $('tab-' + key); button.setAttribute('aria-selected', String(key === tab)); button.tabIndex = key === tab ? 0 : -1;
    }
    active = tab; $('page-title').textContent = labels[tab][0]; $('page-hint').textContent = labels[tab][1];
    if (['grid', 'calib', 'mark'].includes(tab)) await ensureEditor(tab);
    if (tab === 'candidates') await loadCandidates(true);
    if (tab === 'search') await loadLog();
    if (updateHash) history.replaceState(null, '', '#' + tab);
    toast('');
  } catch (e) { toast(e.message, true); }
  finally { switching = false; document.body.removeAttribute('aria-busy'); $('page-hint').textContent = labels[active][1]; }
}
$('tabs').addEventListener('click', e => { const tab = e.target.closest('[data-tab]'); if (tab) switchTab(tab.dataset.tab); });
$('tabs').addEventListener('keydown', e => {
  if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) return;
  e.preventDefault(); const tabs = [...document.querySelectorAll('[data-tab]')];
  const index = tabs.indexOf(document.activeElement); const next = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (index + (e.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next].focus(); switchTab(tabs[next].dataset.tab);
});
addEventListener('message', e => {
  if (e.origin !== location.origin || e.source !== editors.get(active)?.iframe.contentWindow || e.data?.type !== 'terrseed-navigate') return;
  switchTab(e.data.tab);
});
addEventListener('hashchange', () => switchTab(location.hash.slice(1)));
$('go-grid').onclick = () => switchTab('grid'); $('go-candidates').onclick = () => switchTab('candidates');
function kv(container, pairs) {
  container.replaceChildren();
  for (const [label, value] of pairs) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; container.append(dt, dd); }
}
function duration(s) { return s < 60 ? `${Math.floor(s)} 秒` : `${Math.floor(s / 60)} 分 ${Math.floor(s % 60)} 秒`; }
function setStartReasons(reasons) {
  const notice = $('start-reason'); notice.replaceChildren(); notice.hidden = !reasons.length;
  notice.dataset.reasons = reasons.map(reason => reason.code).join(' ');
  for (const reason of reasons) { const line = document.createElement('span'); line.style.display = 'block'; line.textContent = reason.message; notice.append(line); }
  $('start').disabled = !!reasons.length;
}
function renderTasks(st) {
  const tasks = st.tasks || [], live = tasks.find(task => ['running', 'stopping'].includes(task.status));
  if (live) { selectedTaskId = live.id; $('search-backend').value = live.backend; }
  else if (!selectedTaskId && !taskListKey && tasks.length) { selectedTaskId = tasks[0].id; $('search-backend').value = tasks[0].backend; }
  const key = JSON.stringify(tasks.map(task => [task.id, task.status]));
  if (key !== taskListKey) {
    taskListKey = key; $('search-task').replaceChildren();
    const statuses = { running: '运行中', stopping: '正在保存并停止', paused: '已暂停', interrupted: '意外中断', completed: '已完成', failed: '失败, 可重试' };
    const empty = document.createElement('option'); empty.value = ''; empty.textContent = tasks.length ? '选择已保存的任务' : '尚无搜索任务'; $('search-task').append(empty);
    for (const task of tasks) { const option = document.createElement('option'); option.value = task.id; option.textContent = `${task.id.slice(0, 8)} / ${task.backend} / ${statuses[task.status] || task.status} / ${task.parameters.range.join('..')}`; $('search-task').append(option); }
  }
  $('search-task').value = selectedTaskId;
  $('search-task').disabled = !!live || browserSearch.running || startingSearch || transferring;
  const task = selectedTask(st);
  $('resume-search').disabled = !task?.can_resume || task?.backend === 'webgpu' && !webGpuSupported || !!live || browserSearch.running || startingSearch || transferring;
  $('task-detail').textContent = task ? `已保存 ${task.next - task.parameters.range[0]} / ${task.parameters.range[1] - task.parameters.range[0]} 个种子, 安全续跑位置 ${task.next}. ${!task.compatible ? '搜索器版本已变化, 请创建新任务. ' : task.backend === 'webgpu' && !webGpuSupported ? '当前浏览器不支持 WebGPU, 请换用支持的浏览器继续. ' : ''}${task.error || ''}` : '新搜索会自动保存独立任务和断点.';
}
function renderState(st) {
  if (st.param) st = { ...st, param: migrateParam(st.param) };
  state = st; renderTasks(st); $('connection').textContent = '已连接 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const names = st.frames || [], key = JSON.stringify(names);
  if (key !== frameKey) { frameKey = key; renderFrames(names); }
  $('frame-count').textContent = `${names.length} 张`; $('go-grid').disabled = !names.length || uploading;
  $('frames-hint').textContent = names.length ? '点击缩略图上的 × 删除图片. 导入顺序不限制对齐时的图层顺序.' : '尚未导入截图. 点击上方按钮选择图片.';
  $('nav-import').textContent = names.length ? `${names.length} 张截图` : '从这里开始';
  $('nav-grid').textContent = st.param ? `${st.param.frames.filter(f => f.gridCalibrated).length} / ${names.length} 张已调整` : names.length ? '可以开始标定' : '等待截图';
  $('nav-calib').textContent = calibrationCurrent() ? `${st.param.frames.length} 张可拼接` : '等待网格标定';
  $('nav-mark').textContent = st.marks?.columns ? `已标 ${st.marks.columns} 列` : st.param ? '可以开始标注' : '等待对齐';
  const sweep = st.sweep || {}, obs = st.observed;
  $('nav-search').textContent = sweep.running ? '搜索进行中' : obs ? '观测已就绪' : '等待标注';
  $('nav-candidates').textContent = candidateSize(st) ? `${Math.round(candidateSize(st) / 1024)} KB 结果` : '暂无候选';
  kv($('search-info'), [['搜索器', st.searcher_built ? '已编译' : '未编译, 请先在 CUDA 机器运行 just build'], ['观测', obs ? `${obs.valid} 个有效列 / ${obs.columns} 列` : '尚无有效观测'], ['出生点列', obs?.marker ?? '-'], ['状态', sweep.running ? `运行中 ${duration(sweep.elapsed)}` : '空闲']]);
  $('diagnostic').textContent = obs ? `台阶率 ${obs.step_rate}%. ${obs.step_rate < 3 ? '偏低, 建议检查格宽.' : obs.step_rate > 20 ? '偏高, 建议检查标注.' : '可回到标注步骤继续检查.'}` : '请先在标注步骤标出地表, 观测会自动生成.';
  if (obs?.source === 'import') $('diagnostic').textContent = `台阶率 ${obs.step_rate}%. 已导入最终观测, 无需截图或标注画布即可搜索.`;
  if (sweep.running) $('search-backend').value = sweep.backend || 'cuda';
  const backend = $('search-backend').value, local = browserMode(), running = sweep.running || browserSearch.running || st.tasks?.some(task => ['running', 'stopping'].includes(task.status));
  $('gpu-support').textContent = backend === 'webgpu' ? webGpuSupported ? '已检测到 WebGPU 接口, 开始时会申请设备并验证内核. 无需 CUDA.' : '当前环境未提供 WebGPU. 可手动选择 CPU 或 CUDA.' : backend === 'cpu' ? st.cpu_searcher_built ? '使用运行工作台服务的主机 CPU, 无需 GPU 或 CUDA.' : '主机 CPU 搜索器未编译, 请先运行 just build-cpu.' : '调用运行工作台服务的机器上的 NVIDIA CUDA 搜索器.';
  $('nav-search').textContent = running ? '搜索进行中' : obs ? '观测已就绪' : '等待标注';
  const reasons = [];
  if (startingSearch) reasons.push({ code: 'starting', message: '正在准备搜索, 请稍候.' });
  if (transferring) reasons.push({ code: 'transferring', message: '正在导入或导出观测, 请等待操作完成.' });
  if (running) reasons.push({ code: 'running', message: '已有搜索正在运行. 请先停止当前搜索, 再开始新的搜索.' });
  if (!obs) reasons.push({ code: 'observation', message: '尚无最终观测数据. 请先完成地表标注, 或在搜索准备卡片导入观测数据.' });
  if (backend === 'cpu' && !st.cpu_searcher_built) reasons.push({ code: 'cpu-missing', message: `主机 CPU 搜索器不存在. 请在运行工作台服务的主机上运行 just build-cpu. 预期文件: ${st.searcher_paths?.cpu || '仓库根目录的 sweep-cpu (Windows 为 sweep-cpu.exe)'}.` });
  if (backend === 'mlx' && !st.mlx_searcher_built) reasons.push({ code: 'mlx-missing', message: `主机 MLX 搜索器不存在. 请在 macOS 上用 homebrew 安装 mlx 和 mlx-c 后运行 just build-mlx. 预期文件: ${st.searcher_paths?.mlx || '仓库根目录的 sweep-mlx'}. 该后端只支持 Apple GPU.` });
  if (backend === 'cuda' && !st.searcher_built) reasons.push({ code: 'cuda-missing', message: `主机 CUDA 搜索器不存在. 请先在运行工作台服务的主机上编译 CUDA 搜索器, 并将产物放在预期位置: ${st.searcher_paths?.cuda || '仓库根目录的 sweep2 (Windows 为 sweep2.exe)'}. 仅切换到 CUDA 或安装 CUDA 不会生成搜索器.` });
  if (backend === 'webgpu' && !webGpuSupported) reasons.push({ code: 'webgpu-unavailable', message: '当前环境未提供 WebGPU. 请使用支持 WebGPU 的浏览器并通过 localhost 或 HTTPS 打开, 或选择主机 CPU / CUDA.' });
  setStartReasons(reasons);
  $('stop').disabled = !running; $('search-backend').disabled = running || transferring || startingSearch;
  $('export-observation').disabled = startingSearch || transferring || running || !obs; $('import-observation').disabled = startingSearch || transferring || running;
  $('download-browser-candidates').disabled = !local || !(browserSearch.taskId === selectedTaskId && browserSearch.rows.length || selectedTask(st)?.progress.candidates);
  const task = selectedTask(st), ownBrowser = local && browserSearch.taskId === selectedTaskId && browserSearch.hasRun;
  renderSearchProgress($, task ? ownBrowser && browserSearch.running ? browserSearch.progress : task.progress : local ? browserSearch.progress : backend === sweep.backend ? sweep.progress : null, backend);
  if (local) {
    $('nav-candidates').textContent = browserSearch.hasRun ? `${browserSearch.rows.length} 条浏览器候选` : '暂无浏览器候选';
    kv($('search-info'), [['计算方式', '浏览器 GPU / WebGPU'], ['观测', obs ? `${obs.valid} 个有效列 / ${obs.columns} 列` : '尚无有效观测'], ['出生点列', obs?.marker ?? '-'], ['状态', browserSearch.running ? '运行中' : '空闲']]);
  } else if (backend === 'cpu') {
    $('nav-candidates').textContent = candidateSize(st) ? `${Math.round(candidateSize(st) / 1024)} KB CPU 结果` : '暂无 CPU 候选';
    kv($('search-info'), [['计算方式', '主机 CPU'], ['搜索器', st.cpu_searcher_built ? '已编译' : '未编译, 请先运行 just build-cpu'], ['观测', obs ? `${obs.valid} 个有效列 / ${obs.columns} 列` : '尚无有效观测'], ['出生点列', obs?.marker ?? '-'], ['状态', sweep.running ? `运行中 ${duration(sweep.elapsed)}` : '空闲']]);
  } else if (backend === 'mlx') {
    $('nav-candidates').textContent = candidateSize(st) ? `${Math.round(candidateSize(st) / 1024)} KB Apple GPU 结果` : '暂无 Apple GPU 候选';
    kv($('search-info'), [['计算方式', '主机 Apple GPU / MLX'], ['搜索器', st.mlx_searcher_built ? '已编译' : '未编译, 请先运行 just build-mlx'], ['观测', obs ? `${obs.valid} 个有效列 / ${obs.columns} 列` : '尚无有效观测'], ['出生点列', obs?.marker ?? '-'], ['状态', sweep.running ? `运行中 ${duration(sweep.elapsed)}` : '空闲']]);
  }
  if (task) $('nav-candidates').textContent = `${task.backend} 累计 ${task.progress.candidates || 0} 个候选`;
  if ((active === 'search' && sweep.running) || (lastRun && !sweep.running)) loadLog().catch(e => toast(e.message, true));
  if (active === 'candidates' && candidateVersion(st) !== candidateKey) loadCandidates().catch(e => toast(e.message, true));
  lastRun = !!sweep.running;
}
async function refreshState() {
  const version = ++stateRequest, st = await request('/api/state');
  if (version === stateRequest) renderState(st);
  return st;
}
async function poll() {
  if (polling || document.hidden || switching) return;
  polling = true;
  try { await refreshState(); } catch (e) { $('connection').textContent = '连接中断'; setStartReasons([{ code: 'connection', message: '无法连接工作台服务, 请检查服务是否正在运行, 然后刷新状态.' }]); toast('无法更新状态: ' + e.message, true); }
  finally { polling = false; }
}
function renderFrames(names) {
  $('frames').replaceChildren();
  for (const name of names) {
    const figure = document.createElement('figure'), img = document.createElement('img'), caption = document.createElement('figcaption'), del = document.createElement('button');
    img.src = '/frames/' + encodeURIComponent(name); img.alt = name; img.loading = 'lazy';
    caption.textContent = name; caption.title = name; del.className = 'del'; del.textContent = '×'; del.title = '删除 ' + name; del.setAttribute('aria-label', '删除 ' + name);
    del.onclick = async () => {
      if (uploading || switching || !confirm('删除图片 ' + name + '?')) return;
      del.disabled = true;
      try { await request('/api/delete?name=' + encodeURIComponent(name), {}); await refreshState(); }
      catch (e) { toast('删除失败: ' + e.message, true); del.disabled = false; }
    };
    figure.append(img, caption, del); $('frames').append(figure);
  }
}
async function importFiles(files) {
  if (uploading || switching) return;
  const supported = [...files].filter(f => /\.(png|jpe?g|webp|gif|bmp)$/i.test(f.name || '') || /^image\/(png|jpeg|webp|gif|bmp)$/.test(f.type));
  if (!supported.length) { toast('请选择支持的图片文件.'); return; }
  uploading = true; $('pick').disabled = true; $('go-grid').disabled = true;
  const failures = []; let done = 0;
  try {
    for (const [index, file] of supported.entries()) {
      $('upload-status').textContent = `正在导入 ${index + 1} / ${supported.length}: ${file.name || '剪贴板截图'}`;
      const extension = ({ 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'image/bmp': '.bmp' })[file.type] || '.png';
      let name = file.name && /\.(png|jpe?g|webp|gif|bmp)$/i.test(file.name) ? file.name : `clipboard-${Date.now()}-${index}${extension}`;
      if (state?.frames?.includes(name)) name = name.replace(/(\.[^.]+)$/, `-${Date.now()}-${index}$1`);
      try {
        const response = await fetch('/api/upload?name=' + encodeURIComponent(name), { method: 'POST', body: file });
        const result = await response.json(); if (!response.ok || !result.ok) throw new Error(result.error || `HTTP ${response.status}`); done++;
      } catch (e) { failures.push(`${name}: ${e.message}`); }
    }
    $('upload-status').textContent = `已导入 ${done} / ${supported.length} 张.`; await refreshState();
    if (failures.length) toast('部分图片导入失败. ' + failures.join(' / '), true);
  } catch (e) { toast('导入完成后无法更新状态: ' + e.message, true); }
  finally { uploading = false; $('pick').disabled = false; $('go-grid').disabled = !state?.frames?.length; $('file').value = ''; }
}
$('pick').onclick = e => { e.stopPropagation(); $('file').click(); };
$('dropzone').onclick = () => $('file').click();
$('dropzone').onkeydown = e => { if (e.target === $('dropzone') && ['Enter', ' '].includes(e.key)) { e.preventDefault(); $('file').click(); } };
$('file').onchange = e => importFiles(e.target.files);
let dragDepth = 0;
addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; if (active === 'import') $('dropzone').classList.add('dragover'); });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropzone').classList.remove('dragover'); } });
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', async e => { e.preventDefault(); dragDepth = 0; $('dropzone').classList.remove('dragover'); if (active !== 'import') await switchTab('import'); if (active === 'import') importFiles(e.dataTransfer.files); });
addEventListener('paste', e => {
  const images = [...(e.clipboardData?.items || [])].filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
  if (images.length && active === 'import') { e.preventDefault(); importFiles(images); }
});
async function loadLog() {
  if (browserMode() && (!selectedTaskId || browserSearch.taskId === selectedTaskId)) { $('log').textContent = browserSearch.messages.join('\n') || '浏览器搜索尚未启动.'; return; }
  const backend = $('search-backend').value, result = await request('/api/sweep/log?backend=' + backend + taskQuery());
  if ($('search-backend').value === backend) $('log').textContent = result.log || '暂无搜索输出.';
}
async function loadCandidates(force = false) {
  const local = browserMode() && (!selectedTaskId || browserSearch.taskId === selectedTaskId), backend = $('search-backend').value, taskId = selectedTaskId;
  if (loadingCandidates || (!local && !force && candidateKey === candidateVersion(state))) return;
  const version = candidateVersion(state);
  loadingCandidates = true;
  let result;
  try { result = local ? { rows: browserSearch.lines().slice(0, 200) } : await request('/api/candidates?backend=' + backend + taskQuery()); }
  finally { loadingCandidates = false; }
  if ($('search-backend').value !== backend || taskId !== selectedTaskId) return;
  candidateKey = version;
  $('candidates').replaceChildren();
  for (const [index, row] of (result.rows || []).entries()) { const tr = document.createElement('tr'), rank = document.createElement('td'), value = document.createElement('td'); rank.textContent = index + 1; value.textContent = row; tr.append(rank, value); $('candidates').append(tr); }
  const live = selectedTask(state) ? ['running', 'stopping'].includes(selectedTask(state).status) : local ? browserSearch.running : state?.sweep?.running && state.sweep.backend === backend;
  $('candidate-hint').textContent = result.rows?.length ? `显示前 ${result.rows.length} 条候选. ${live ? '搜索中自动刷新, 高分候选可能替换已有记录. ' : ''}需要结合游戏内地形进一步核对.` : live ? '搜索进行中, 暂无已发布的候选. 本页会自动刷新.' : '暂无候选. 完成标注并运行搜索后会在这里显示.';
}
async function startTask(resume = false) {
  if (startingSearch || browserSearch.running || state?.sweep?.running || state?.tasks?.some(task => ['running', 'stopping'].includes(task.status)) || transferring) return;
  startingSearch = true; if (state) renderState(state);
  let launched;
  try {
    const payload = await request(resume ? '/api/task/resume' : '/api/task/start', resume ? { id: selectedTaskId } : { backend: $('search-backend').value, parameters: searchParameters.read() });
    launched = payload;
    const { task, observation, parameters, owner } = payload;
    selectedTaskId = task.id; $('search-backend').value = task.backend; searchParameters.write(parameters); candidateKey = '';
    await refreshState();
    if (task.backend === 'webgpu') {
      const identity = { id: task.id, owner };
      const running = browserSearch.start(observation, parameters, {
        id: task.id, next: task.next, matched: payload.matched, elapsed: payload.elapsed,
        rows: payload.rows.map(row => ({ ...row, score: row.score / 10000000 })),
        commit: block => request('/api/task/commit', { ...identity, ...block }),
        heartbeat: () => request('/api/task/heartbeat', identity),
        finish: failed => request('/api/task/finish', { ...identity, failed })
      });
      startingSearch = false; await running;
    } else await loadLog();
  } catch (error) {
    if (launched?.task.backend === 'webgpu') { try { await request('/api/task/finish', { id: launched.task.id, owner: launched.owner, failed: true }); } catch { /* 会话可能已经释放, 失联时由服务回收. */ } }
    toast((resume ? '恢复失败: ' : '启动失败: ') + error.message, true);
  }
  finally { startingSearch = false; if (state) renderState(state); await poll(); }
}
$('start').onclick = () => startTask();
$('resume-search').onclick = () => startTask(true);
$('stop').onclick = async () => {
  $('stop').disabled = true;
  if (browserSearch.running) browserSearch.stop();
  try {
    await request(selectedTaskId ? '/api/task/stop' : '/api/sweep/stop', selectedTaskId ? { id: selectedTaskId } : {});
    await refreshState(); await loadLog();
  } catch (error) { toast('停止失败: ' + error.message, true); }
};
$('refresh').onclick = async () => { try { await flushCurrent(); await refreshState(); toast(''); } catch (e) { toast(e.message, true); } };
$('refresh-candidates').onclick = () => loadCandidates(true).catch(e => toast(e.message, true));
try { await refreshState(); const tab = location.hash.slice(1); if (labels[tab] && tab !== active) await switchTab(tab, { updateHash: false }); }
catch (e) { setStartReasons([{ code: 'connection', message: '无法读取搜索状态. 请检查工作台服务是否正在运行, 然后刷新状态.' }]); toast('连接失败: ' + e.message, true); }
setInterval(poll, 1000);
