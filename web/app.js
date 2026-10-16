/* 步骤切换, 素材导入和搜索状态. */
import { $, frameName, request } from './editor-core.js';
const labels = {
  import: ['导入主播截图', '导入原始截图, 然后进入对齐步骤.'],
  calib: ['对齐与校准', '锁定图片, 微调参数. 修改自动保存, 下一步直接继承.'],
  mark: ['标注地表', '点击或拖动标注. 自动保存, 可随时回到对齐步骤.'],
  search: ['粗筛搜索', '使用已保存的最新观测进行搜索.'],
  candidates: ['查看候选', '查看搜索产出的候选记录.']
};
let active = 'import', state = null, switching = false, polling = false, uploading = false;
let frameKey = '', candidateKey = '', lastRun = false, stateRequest = 0;
const editors = new Map();
function toast(message, error = false) {
  const container = $('app-notice'); container.hidden = !message; container.classList.toggle('error', error); container.replaceChildren();
  if (!message) return;
  const span = document.createElement('span'); span.textContent = message;
  const close = document.createElement('button'); close.textContent = '关闭'; close.onclick = () => { container.hidden = true; }; container.append(span, close);
}
function editorKey(tab) {
  const geometry = state?.param?.frames?.map(({ id, src, x, y, tile, tileY, phaseX, phaseY, on }) => ({ id, src, x, y, tile, tileY, phaseX, phaseY, on }));
  return JSON.stringify(tab === 'calib' ? state?.frames : [state?.frames, geometry]);
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
  const iframe = document.createElement('iframe'); iframe.title = labels[tab][0]; iframe.src = `/web/${tab === 'calib' ? 'calib' : 'mark'}.html?embedded=1`;
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
    if (tab === 'calib' && !state.frames.length) { toast('请先导入至少一张截图.'); return; }
    if (tab === 'mark' && (!calibrationCurrent() || !state.param?.frames?.some(f => f.on !== false))) { toast('请先在对齐步骤中确认当前截图, 并显示至少一张图片. 参数会自动保存.'); return; }
    if (['search', 'candidates'].includes(tab) && state.marks?.columns) {
      if (!calibrationCurrent()) { toast('截图列表已变化, 请先进入对齐步骤确认.'); return; }
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
    if (tab === 'calib' || tab === 'mark') await ensureEditor(tab);
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
$('go-calib').onclick = () => switchTab('calib'); $('go-candidates').onclick = () => switchTab('candidates');
function kv(container, pairs) {
  container.replaceChildren();
  for (const [label, value] of pairs) { const dt = document.createElement('dt'), dd = document.createElement('dd'); dt.textContent = label; dd.textContent = value; container.append(dt, dd); }
}
function duration(s) { return s < 60 ? `${Math.floor(s)} 秒` : `${Math.floor(s / 60)} 分 ${Math.floor(s % 60)} 秒`; }
function renderState(st) {
  state = st; $('connection').textContent = '已连接 · ' + new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const names = st.frames || [], key = JSON.stringify(names);
  if (key !== frameKey) { frameKey = key; renderFrames(names); }
  $('frame-count').textContent = `${names.length} 张`; $('go-calib').disabled = !names.length || uploading;
  $('frames-hint').textContent = names.length ? '点击缩略图上的 × 删除图片. 导入顺序不限制对齐时的图层顺序.' : '尚未导入截图. 点击上方按钮选择图片.';
  $('nav-import').textContent = names.length ? `${names.length} 张截图` : '从这里开始';
  $('nav-calib').textContent = st.param ? `${st.param.frames.length} 张已保存` : names.length ? '可以开始对齐' : '等待截图';
  $('nav-mark').textContent = st.marks?.columns ? `已标 ${st.marks.columns} 列` : st.param ? '可以开始标注' : '等待对齐';
  const sweep = st.sweep || {}, obs = st.observed;
  $('nav-search').textContent = sweep.running ? '搜索进行中' : obs ? '观测已就绪' : '等待标注';
  $('nav-candidates').textContent = sweep.candidates ? `${Math.round(sweep.candidates / 1024)} KB 结果` : '暂无候选';
  kv($('search-info'), [['搜索器', st.searcher_built ? '已编译' : '未编译, 请先在 CUDA 机器运行 just build'], ['观测', obs ? `${obs.valid} 个有效列 / ${obs.columns} 列` : '尚无有效观测'], ['出生点列', obs?.marker ?? '-'], ['状态', sweep.running ? `运行中 ${duration(sweep.elapsed)}` : '空闲']]);
  $('diagnostic').textContent = obs ? `台阶率 ${obs.step_rate}%. ${obs.step_rate < 3 ? '偏低, 建议检查格宽.' : obs.step_rate > 20 ? '偏高, 建议检查标注.' : '可回到标注步骤继续检查.'}` : '请先在标注步骤标出地表, 观测会自动生成.';
  $('start').disabled = sweep.running || !st.searcher_built || !obs; $('stop').disabled = !sweep.running;
  if ((active === 'search' && sweep.running) || (lastRun && !sweep.running)) loadLog().catch(e => toast(e.message, true));
  if (active === 'candidates' && String(sweep.candidates) !== candidateKey) loadCandidates().catch(e => toast(e.message, true));
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
  try { await refreshState(); } catch (e) { $('connection').textContent = '连接中断'; toast('无法更新状态: ' + e.message, true); }
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
  uploading = true; $('pick').disabled = true; $('go-calib').disabled = true;
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
  finally { uploading = false; $('pick').disabled = false; $('go-calib').disabled = !state?.frames?.length; $('file').value = ''; }
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
async function loadLog() { const result = await request('/api/sweep/log'); $('log').textContent = result.log || '暂无搜索输出.'; }
async function loadCandidates(force = false) {
  if (!force && candidateKey === String(state?.sweep?.candidates)) return;
  const result = await request('/api/candidates'); candidateKey = String(state?.sweep?.candidates);
  $('candidates').replaceChildren();
  for (const [index, row] of (result.rows || []).entries()) { const tr = document.createElement('tr'), rank = document.createElement('td'), value = document.createElement('td'); rank.textContent = index + 1; value.textContent = row; tr.append(rank, value); $('candidates').append(tr); }
  $('candidate-hint').textContent = result.rows?.length ? `显示前 ${result.rows.length} 条候选. 需要结合游戏内地形进一步核对.` : '暂无候选. 完成标注并运行搜索后会在这里显示.';
}
$('start').onclick = async () => {
  const tol = $('tol'), offer = $('offer'); if (!tol.reportValidity() || !offer.reportValidity() || !tol.value || !offer.value) return;
  $('start').disabled = true;
  try { await request('/api/sweep', { tol: tol.valueAsNumber, offer: offer.valueAsNumber, scales: '1.00' }); await refreshState(); await loadLog(); }
  catch (e) { toast('启动失败: ' + e.message, true); await poll(); }
};
$('stop').onclick = async () => { $('stop').disabled = true; try { await request('/api/sweep/stop', {}); await refreshState(); await loadLog(); } catch (e) { toast('停止失败: ' + e.message, true); } };
$('refresh').onclick = async () => { try { await flushCurrent(); await refreshState(); toast(''); } catch (e) { toast(e.message, true); } };
$('refresh-candidates').onclick = () => loadCandidates(true).catch(e => toast(e.message, true));
try { await refreshState(); const tab = location.hash.slice(1); if (labels[tab] && tab !== active) await switchTab(tab, { updateHash: false }); }
catch (e) { toast('连接失败: ' + e.message, true); }
setInterval(poll, 5000);
