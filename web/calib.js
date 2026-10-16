/* 图片拼接的选图, 锁定与位置操作. */
import { $, Autosave, History, Viewport, bindPan, bindViewButtons, boundsOf, drawFrame, editing, hitFrame, installLeaveGuard, loadFrames, notify, request, serializeFrames, setSaveState } from './editor-core.js';
import { PARAM_VERSION } from './frame-schema.js';
let frames = [], selected = null, saved = '', ready = false, alpha = .65, grid = .45, inputBefore = null;
const history = new History();
const autosave = new Autosave(save, () => dirty());
let resolveReady, rejectReady;
const whenReady = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
whenReady.catch(() => {});
window.editorBridge = { flush: async () => { await whenReady; await autosave.flush(); }, diagnostics: () => ({ ready, frames: frames.length, dirty: dirty(), paints: view.frames, paintMs: view.lastPaintMs }) };
if (parent !== window) document.body.classList.add('embedded');
const snapshot = () => serializeFrames(frames);
const fingerprint = () => JSON.stringify(snapshot());
const dirty = () => ready && fingerprint() !== saved;
const view = new Viewport($('workspace'), (ctx, v) => {
  for (const f of frames) drawFrame(ctx, v, f, { opacity: alpha, grid, selected: f === selected });
});
bindViewButtons(view, () => frames); installLeaveGuard(dirty);
function changed() {
  setSaveState(dirty(), dirty() ? '正在自动保存...' : '已自动保存'); $('undo').disabled = !history.past.length; $('redo').disabled = !history.future.length;
  if (dirty()) autosave.schedule();
  $('save').disabled = !frames.length; view.invalidate();
}
function mutate(fn) { history.push(snapshot()); fn(); renderList(); sync(); changed(); }
function restore(value) {
  if (!value) return;
  const images = new Map(frames.map(f => [f.id, { img: f.img, failed: f.failed }]));
  const id = selected?.id;
  frames = value.map(f => ({ ...f, ...images.get(f.id) })); selected = frames.find(f => f.id === id) || frames[0];
  renderList(); sync(); changed();
}
function select(f) { selected = f; renderList(); sync(); view.invalidate(); }
function renderList() {
  $('frames').replaceChildren(); $('count').textContent = `${frames.length} 张`;
  for (const f of [...frames].reverse()) {
    const item = document.createElement('div'); item.className = 'frame-item' + (f === selected ? ' selected' : '');
    const button = document.createElement('button'); button.className = 'select-frame'; button.setAttribute('aria-pressed', String(f === selected));
    const span = document.createElement('span'); span.textContent = f.src.split('/').pop(); button.append(span); button.title = `${f.id}: ${span.textContent}`; button.onclick = () => select(f);
    const visible = document.createElement('button'); visible.className = 'icon'; visible.textContent = f.on ? '显示' : '隐藏'; visible.title = '切换图片可见性'; visible.setAttribute('aria-pressed', String(f.on)); visible.onclick = () => mutate(() => { f.on = !f.on; });
    const lock = document.createElement('button'); lock.className = 'icon'; lock.textContent = f.locked ? '已锁' : '锁定'; lock.title = '切换位置锁定'; lock.setAttribute('aria-pressed', String(f.locked)); lock.onclick = () => mutate(() => { f.locked = !f.locked; });
    item.append(button, visible, lock); $('frames').append(item);
    if (f.failed) { const error = document.createElement('p'); error.className = 'hint bad'; error.textContent = `${f.id} 图片加载失败`; $('frames').append(error); }
  }
}
const fields = ['x', 'y'];
function sync() {
  $('inspector').hidden = !selected;
  if (!selected) return;
  $('selected-name').textContent = selected.id;
  for (const key of fields) { if (document.activeElement !== $(key)) $(key).value = Number(selected[key].toFixed(3)); }
  $('visible').checked = selected.on; $('locked').checked = selected.locked;
  $('grid-summary').textContent = `格宽 ${selected.tile.toFixed(6)} px · 格高 ${selected.tileY.toFixed(6)} px · 相位 ${selected.phaseX.toFixed(3)}, ${selected.phaseY.toFixed(3)} px`;
  for (const key of ['x', 'y']) $(key).disabled = selected.locked;
  document.querySelectorAll('[data-dx]').forEach(b => b.disabled = selected.locked);
  $('selection').textContent = `${selected.id} · ${selected.img.naturalWidth} × ${selected.img.naturalHeight} px · ${selected.locked ? '位置已锁定' : '可拖动'}${selected.on ? '' : ' · 已隐藏'}`;
}
for (const key of fields) {
  const el = $(key);
  el.addEventListener('focus', () => { inputBefore = snapshot(); });
  el.addEventListener('input', () => {
    if (!selected || !el.value.trim() || !el.checkValidity() || !Number.isFinite(el.valueAsNumber)) return;
    if (selected.locked && ['x', 'y'].includes(key)) return;
    selected[key] = el.valueAsNumber;
    changed();
  });
  el.addEventListener('change', () => {
    if (inputBefore && JSON.stringify(inputBefore) !== fingerprint()) { history.push(inputBefore); inputBefore = snapshot(); }
    // 输入为空或非法时恢复最后一次有效值, 避免 NaN 破坏视口.
    if (selected) el.value = Number(selected[key].toFixed(3)); changed();
  });
  el.addEventListener('blur', () => { if (selected) el.value = Number(selected[key].toFixed(3)); inputBefore = null; });
}
$('visible').onchange = () => mutate(() => { selected.on = $('visible').checked; });
$('locked').onchange = () => mutate(() => { selected.locked = $('locked').checked; });
$('lock-all').onclick = () => { if (frames.some(f => !f.locked)) mutate(() => frames.forEach(f => f.locked = true)); };
$('unlock-all').onclick = () => { if (frames.some(f => f.locked)) mutate(() => frames.forEach(f => f.locked = false)); };
$('front').onclick = () => { if (selected && frames.at(-1) !== selected) mutate(() => { frames = frames.filter(f => f !== selected).concat(selected); }); };
$('focus-frame').onclick = () => { if (selected?.img.naturalWidth) view.fit(boundsOf([{ ...selected, on: true }])); };
function nudge(dx, dy, factor = 1) {
  if (!selected || selected.locked) return;
  const step = Number($('nudge-step').value) * factor;
  mutate(() => { selected.x = Math.round((selected.x + dx * step) * 1000) / 1000; selected.y = Math.round((selected.y + dy * step) * 1000) / 1000; });
}
document.querySelectorAll('[data-dx]').forEach(b => b.onclick = () => nudge(Number(b.dataset.dx), Number(b.dataset.dy)));
$('alpha').oninput = e => { alpha = Number(e.target.value); view.invalidate(); };
$('grid').oninput = e => { grid = Number(e.target.value); view.invalidate(); };
$('undo').onclick = () => restore(history.undo(snapshot()));
$('redo').onclick = () => restore(history.redo(snapshot()));
bindPan(view, (point, e) => {
  if (e.button !== 0 || !ready) return null;
  const f = hitFrame(frames, point);
  if (!f) return { kind: 'pan', screen: view.screen(e), x: view.panX, y: view.panY };
  select(f);
  if (f.locked) { notify('这张图片的位置已锁定. 可在左侧解锁, 或按 L 解锁.'); return null; }
  return { kind: 'frame', f, point, x: f.x, y: f.y, before: snapshot() };
}, (point, drag) => {
  if (!point) return;
  $('cursor').textContent = `X ${point.x.toFixed(1)} · Y ${point.y.toFixed(1)} px`;
  if (!drag) return;
  drag.f.x = drag.x + point.x - drag.point.x; drag.f.y = drag.y + point.y - drag.point.y;
  view.invalidate();
}, drag => {
  if (JSON.stringify(drag.before) !== fingerprint()) history.push(drag.before);
  sync(); changed();
});
async function save() {
  if (!ready || !frames.length) return false;
  const state = snapshot(), key = JSON.stringify(state); $('save').disabled = true;
  try {
    await request('/api/frames', { version: PARAM_VERSION, frames: state }); saved = key;
    if ($('save').classList.contains('retry')) notify('修改已自动保存.');
    setSaveState(dirty(), dirty() ? '正在保存新的修改...' : '已自动保存'); $('save').classList.remove('retry'); return true;
  } catch (e) { notify('自动保存失败: ' + e.message + '. 修改仍保留在此页面, 可点击重试保存.', true); setSaveState(true, '保存失败'); $('save').classList.add('retry'); return false; }
  finally { $('save').disabled = false; }
}
$('save').onclick = () => autosave.flush().catch(() => {});
$('next').onclick = async e => { if (!ready || !frames.some(f => f.on && !f.failed)) { e.preventDefault(); notify('请先导入并显示至少一张图片.', true); } else if (dirty()) { e.preventDefault(); try { await autosave.flush(); location.href = '/web/mark.html'; } catch {} } };
$('reset').onclick = () => {
  if (!frames.length || !confirm('重新排列全部图片? 网格标定保持不变, 当前布局可以通过撤销恢复.')) return;
  mutate(() => {
    let x = 0;
    for (const f of frames) { Object.assign(f, { x, y: 0, locked: false, on: true }); x += (f.img.naturalWidth || 1600) * .8; }
  }); view.fit(boundsOf(frames));
};
addEventListener('keydown', e => {
  const key = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && key === 's') { e.preventDefault(); autosave.flush().catch(() => {}); return; }
  if (editing(e.target)) return;
  if (mod && key === 'z') { e.preventDefault(); (e.shiftKey ? $('redo') : $('undo')).click(); }
  else if (mod && key === 'y') { e.preventDefault(); $('redo').click(); }
  else if (!mod && key === 'l' && selected) mutate(() => { selected.locked = !selected.locked; });
  else if (!mod && key === 'f') $('fit').click();
  else if (!mod && e.key.startsWith('Arrow')) { e.preventDefault(); nudge(e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0, e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0, e.shiftKey ? 10 : 1); }
});
try {
  const result = await loadFrames(new URLSearchParams(location.search).has('fresh'));
  frames = result.frames; selected = frames[0] || null;
  saved = result.calibrated && !result.changed ? fingerprint() : ''; ready = true;
  renderList(); sync(); changed(); $('empty').hidden = frames.length > 0; view.fit(boundsOf(frames));
  if (!frames.length) { setSaveState(false, '等待导入'); $('selection').textContent = '尚未导入截图'; }
  else if (result.changed) notify('截图列表有变化, 已保留现有图片的对齐参数. 请检查后保存.');
  else if (!result.calibrated) notify('从新导入的截图开始. 所有调整会自动保存.');
  resolveReady();
} catch (e) { notify('加载失败: ' + e.message, true); setSaveState(false, '加载失败'); rejectReady(e); }
