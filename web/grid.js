/* 左右键分别拖选两条网格线, 松开确认, Ctrl 拖动已选线调整相位. */
import { $, Autosave, History, Viewport, bindPan, bindViewButtons, boundsOf, clamp, drawFrame, editing, installLeaveGuard, loadFrames, notify, request, serializeFrames, setSaveState } from './editor-core.js';
import { PARAM_VERSION } from './frame-schema.js';
import { applyMeasurement, guideFor, modulo, moveGridEndpoint, nearestGridLine, selectedGridPair } from './grid-model.js';
let frames = [], selected = null, axis = 'x', grid = .45, ready = false, saved = '', inputBefore = null;
let transaction = null, activeEnd = 'moving';
const picks = new Map();
const pickKey = () => `${selected?.id}:${axis}`;
const activeGuide = () => picks.has(pickKey()) ? picks.get(pickKey()) : selected?.gridGuides?.[axis] ? guideFor(selected, axis) : null;
const history = new History(), views = new Map();
const snapshot = () => serializeFrames(frames), fingerprint = () => JSON.stringify(snapshot());
const dirty = () => ready && fingerprint() !== saved;
const autosave = new Autosave(save, () => dirty() && !transaction);
let resolveReady, rejectReady;
const whenReady = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); whenReady.catch(() => {});
window.editorBridge = {
  flush: async () => { await whenReady; if (transaction) throw new Error('请先松开鼠标确认网格线, 或按 Esc 取消拖动.'); await autosave.flush(); },
  diagnostics: () => ({ ready, frames: frames.length, dirty: dirty(), axis, guide: activeGuide(), selecting: !!transaction?.selecting, dragMode: transaction ? transaction.phaseAxis ? 'phase' : 'spacing' : null, activeEnd, zoom: view.zoom, panX: view.panX, panY: view.panY })
};
if (parent !== window) document.body.classList.add('embedded');
const local = () => selected ? { ...selected, x: 0, y: 0, on: true } : null;
const view = new Viewport($('workspace'), (ctx, v) => {
  if (selected) drawFrame(ctx, v, local(), { grid });
}, (ctx, v) => {
  if (!selected || selected.failed) return;
  const guide = activeGuide(), b = v.bounds, horizontal = axis === 'x';
  if (!guide) return;
  for (const [key, color, label] of [['fixed', '#72dfbe', '第一条'], ['moving', '#ffd185', '第二条']]) {
    if (!Number.isFinite(guide[key])) continue;
    const coordinate = guide[key]; ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = (activeEnd === key ? 3 : 2) / v.zoom;
    ctx.beginPath();
    if (horizontal) { ctx.moveTo(coordinate, b.y); ctx.lineTo(coordinate, b.bottom); }
    else { ctx.moveTo(b.x, coordinate); ctx.lineTo(b.right, coordinate); }
    ctx.stroke(); ctx.font = `${12 / v.zoom}px sans-serif`;
    const visible = horizontal ? coordinate >= b.x && coordinate <= b.right : coordinate >= b.y && coordinate <= b.bottom;
    if (visible) {
      const tx = horizontal ? coordinate + 8 / v.zoom : b.x + 12 / v.zoom;
      const ty = horizontal ? b.y + 72 / v.zoom : coordinate - 8 / v.zoom;
      ctx.fillText(label + (transaction?.endpoint === key ? ' · 松开确认' : ' · 可拖动'), tx, ty);
      ctx.fillRect(horizontal ? coordinate - 5 / v.zoom : b.x + 5 / v.zoom, horizontal ? b.y + 84 / v.zoom : coordinate - 5 / v.zoom, 10 / v.zoom, 10 / v.zoom);
    }
  }
  if (guide.cells) {
    const middle = (guide.fixed + guide.moving) / 2;
    ctx.strokeStyle = '#ffd185b0'; ctx.lineWidth = 1 / v.zoom; ctx.beginPath();
    if (horizontal) { const y = b.y + 105 / v.zoom; ctx.moveTo(guide.fixed, y); ctx.lineTo(guide.moving, y); }
    else { const x = b.x + 105 / v.zoom; ctx.moveTo(x, guide.fixed); ctx.lineTo(x, guide.moving); }
    ctx.stroke(); ctx.fillStyle = '#ffd185';
    if (horizontal && middle >= b.x && middle <= b.right) ctx.fillText(`${guide.cells} 格`, middle, b.y + 123 / v.zoom);
  }
  syncMetrics();
});
bindViewButtons(view, () => selected ? [local()] : []); installLeaveGuard(dirty);
function syncMetrics() {
  if (!selected) return;
  const guide = activeGuide(), spacing = axis === 'x' ? selected.tile : selected.tileY;
  $('fixed-value').textContent = Number.isFinite(guide?.fixed) ? `${guide.fixed.toFixed(3)} px` : '尚未选择';
  $('moving-value').textContent = Number.isFinite(guide?.moving) ? `${guide.moving.toFixed(3)} px` : '尚未选择';
  $('spacing').textContent = `${spacing.toFixed(6)} px / 格`;
  $('measurement').textContent = guide?.cells ? `${Math.abs(guide.moving - guide.fixed).toFixed(3)} px / ${guide.cells} 格` : '左键选第一条, 右键选第二条';
  $('cells').disabled = !guide?.cells || !!transaction;
  if (document.activeElement !== $('cells')) $('cells').value = guide?.cells ?? '';
  $('focus-fixed').disabled = !Number.isFinite(guide?.fixed); $('focus-moving').disabled = !Number.isFinite(guide?.moving);
  $('line-minus').disabled = $('line-plus').disabled = !guide;
}
function sync() {
  $('inspector').hidden = $('numeric').hidden = !selected;
  if (!selected) return;
  $('selected-name').textContent = selected.id;
  for (const key of ['tile', 'tileY', 'phaseX', 'phaseY']) if (document.activeElement !== $(key)) $(key).value = Number(selected[key].toFixed(6));
  $('axis-x').setAttribute('aria-pressed', String(axis === 'x')); $('axis-y').setAttribute('aria-pressed', String(axis === 'y'));
  $('active-line').textContent = `微调${activeEnd === 'fixed' ? '第一条' : '第二条'}`;
  $('selection').textContent = transaction ? `${transaction.phaseAxis ? '平移相位' : '调整格距'} · 松开鼠标确认 · Esc 取消` : '左键选第一条 · 右键选第二条 · Ctrl 拖动已选线调整相位';
  syncMetrics();
}
function renderList() {
  $('frames').replaceChildren(); $('count').textContent = `${frames.length} 张`;
  for (const f of frames) {
    const item = document.createElement('div'); item.className = 'frame-item' + (f === selected ? ' selected' : '');
    const button = document.createElement('button'); button.className = 'select-frame'; button.setAttribute('aria-pressed', String(f === selected));
    const name = document.createElement('span'); name.textContent = f.src.split('/').pop(); button.append(name); button.title = name.textContent; button.onclick = () => select(f);
    const status = document.createElement('span'); status.className = 'badge'; status.textContent = f.failed ? '加载失败' : f.gridCalibrated ? '已调整' : '待标定'; item.append(button, status); $('frames').append(item);
  }
}
function changed() {
  setSaveState(dirty(), dirty() ? '正在自动保存...' : '已自动保存'); if (dirty()) autosave.schedule();
  $('undo').disabled = !history.past.length; $('redo').disabled = !history.future.length; $('save').disabled = !frames.length;
  view.invalidate();
}
function restoreFrames(value) {
  const images = new Map(frames.map(f => [f.id, { img: f.img, failed: f.failed }])), id = selected?.id;
  frames = value.map(f => ({ ...f, ...images.get(f.id) })); selected = frames.find(f => f.id === id) || frames[0];
}
function cancelDrag() {
  if (!transaction) return;
  const tx = transaction; tx.cancelled = true; restoreFrames(tx.before);
  if (tx.hadPick) picks.set(tx.key, tx.pick); else picks.delete(tx.key);
  transaction = null; sync(); changed();
}
function select(f) {
  cancelDrag();
  if (selected) views.set(selected.id, { zoom: view.zoom, panX: view.panX, panY: view.panY });
  selected = f;
  const old = views.get(f.id); if (old) { Object.assign(view, old); view.invalidate(); } else view.fit(boundsOf([local()]));
  renderList(); sync(); view.invalidate();
}
function restore(value) {
  if (!value) return; cancelDrag(); restoreFrames(value); picks.clear();
  renderList(); sync(); changed();
}
function update(guide, commit = false) {
  if (!selected || selected.failed) return false;
  try {
    const patch = applyMeasurement(selected, axis, guide, $('square').checked);
    if (commit) history.push(snapshot()); Object.assign(selected, patch); picks.delete(pickKey());
    if (commit) { renderList(); sync(); changed(); } else { sync(); view.invalidate(); }
    return true;
  } catch (e) { if (commit) notify(e.message, true); return false; }
}
function chooseAxis(next) { cancelDrag(); axis = next; sync(); view.invalidate(false); }
$('axis-x').onclick = () => chooseAxis('x'); $('axis-y').onclick = () => chooseAxis('y');
$('reselect').onclick = () => { cancelDrag(); picks.set(pickKey(), null); activeEnd = 'fixed'; sync(); view.invalidate(false); };
$('cells').onchange = e => {
  const guide = activeGuide(), el = e.target, cells = el.valueAsNumber;
  if (!guide?.cells || transaction) return;
  if (el.value.trim() && Number.isSafeInteger(cells) && cells >= 1 && cells <= 100000) update({ ...guide, cells }, true);
  else notify('间隔格数必须是 1-100000 的整数.', true);
  el.value = activeGuide().cells;
};
function focusLine(key) {
  if (!selected) return;
  const value = activeGuide()?.[key]; if (!Number.isFinite(value)) return;
  activeEnd = key;
  if (axis === 'x') view.panX = view.width / 2 - value * view.zoom;
  else view.panY = view.height / 2 - value * view.zoom;
  sync(); view.invalidate();
}
$('focus-fixed').onclick = () => focusLine('fixed'); $('focus-moving').onclick = () => focusLine('moving');
function translateSingle(endpoint, coordinate) {
  if (!selected) return;
  const tile = axis === 'x' ? selected.tile : selected.tileY, phaseKey = axis === 'x' ? 'phaseX' : 'phaseY';
  selected[phaseKey] = modulo(coordinate, tile); selected.gridCalibrated = true;
  const guides = { ...selected.gridGuides }; delete guides[axis]; selected.gridGuides = guides;
  picks.set(pickKey(), { [endpoint]: coordinate }); sync(); view.invalidate();
}
function nudge(sign, factor = 1) {
  if (!selected || transaction) return;
  const guide = activeGuide(); if (!guide) return;
  const endpoint = guide.cells ? activeEnd : Number.isFinite(guide.fixed) ? 'fixed' : 'moving', delta = sign * Number($('line-step').value) * factor;
  if (!guide.cells) { history.push(snapshot()); translateSingle(endpoint, guide[endpoint] + delta); changed(); return; }
  try { update(moveGridEndpoint(guide, endpoint, guide[endpoint] + delta), true); } catch (e) { notify(e.message, true); }
}
$('line-minus').onclick = () => nudge(-1); $('line-plus').onclick = () => nudge(1);
for (const key of ['tile', 'tileY', 'phaseX', 'phaseY']) {
  const el = $(key);
  el.addEventListener('focus', () => { inputBefore = snapshot(); });
  el.addEventListener('input', () => {
    if (!selected || !el.value.trim() || !el.checkValidity() || !Number.isFinite(el.valueAsNumber)) return;
    const targetAxis = ['tile', 'phaseX'].includes(key) ? 'x' : 'y', guide = guideFor(selected, targetAxis);
    if (key.startsWith('tile')) {
      const moving = guide.fixed + Math.sign(guide.moving - guide.fixed || 1) * guide.cells * el.valueAsNumber;
      Object.assign(selected, applyMeasurement(selected, targetAxis, { ...guide, moving }, $('square').checked));
    } else {
      const delta = el.valueAsNumber - selected[key]; selected[key] = el.valueAsNumber;
      selected.gridGuides = { ...selected.gridGuides, [targetAxis]: { ...guide, fixed: guide.fixed + delta, moving: guide.moving + delta } }; selected.gridCalibrated = true;
    }
    picks.delete(`${selected.id}:${targetAxis}`); sync(); changed();
  });
  el.addEventListener('change', () => {
    if (inputBefore && JSON.stringify(inputBefore) !== fingerprint()) history.push(inputBefore);
    inputBefore = snapshot(); if (selected) el.value = Number(selected[key].toFixed(6)); renderList(); changed();
  });
  el.addEventListener('blur', () => { if (selected) el.value = Number(selected[key].toFixed(6)); inputBefore = null; });
}
$('grid').oninput = e => { grid = Number(e.target.value); view.invalidate(); };
$('undo').onclick = () => restore(history.undo(snapshot())); $('redo').onclick = () => restore(history.redo(snapshot()));
function preview(tx, coordinate) {
  if (tx.cancelled) return;
  if (tx.guide?.cells) {
    try { update(moveGridEndpoint(tx.guide, tx.endpoint, coordinate)); } catch { /* 保留最后一个有效位置, 避免跨越另一端. */ }
  } else translateSingle(tx.endpoint, coordinate);
}
function previewPhase(tx, point) {
  if (tx.cancelled) return;
  const target = tx.phaseAxis, delta = point[target] - tx.startPoint[target];
  const phaseKey = target === 'x' ? 'phaseX' : 'phaseY', spacing = target === 'x' ? tx.base.tile : tx.base.tileY;
  selected[phaseKey] = modulo(tx.base[phaseKey] + delta, spacing); selected.gridCalibrated = true;
  if (tx.baseGuide) selected.gridGuides = { ...selected.gridGuides, [target]: { ...tx.baseGuide, fixed: tx.baseGuide.fixed + delta, moving: tx.baseGuide.moving + delta } };
  if (tx.phasePick) picks.set(tx.key, Object.fromEntries(Object.entries(tx.phasePick).map(([key, value]) => [key, key === 'fixed' || key === 'moving' ? value + delta : value])));
  sync(); view.invalidate();
}
function setDragMode(tx, phase) {
  if (tx.cancelled || !!tx.phaseAxis === phase) return;
  const point = tx.lastPoint;
  if (phase) {
    Object.assign(tx, { phaseAxis: axis, startPoint: point, base: { ...selected }, baseGuide: selected.gridGuides?.[axis] ? guideFor(selected, axis) : null, phasePick: structuredClone(picks.get(tx.key)) });
  } else {
    tx.guide = structuredClone(activeGuide()); tx.offset = point[axis] - tx.guide[tx.endpoint]; delete tx.phaseAxis;
  }
  sync();
}
function moveDrag(tx, point, event) {
  if (typeof event.ctrlKey === 'boolean') setDragMode(tx, event.ctrlKey);
  if (tx.phaseAxis) previewPhase(tx, point);
  else preview(tx, clamp(point[axis] - tx.offset, 0, axis === 'x' ? selected.img.naturalWidth : selected.img.naturalHeight));
  tx.lastPoint = point;
}
bindPan(view, (point, e) => {
  if (!selected || selected.failed || (e.button !== 0 && e.button !== 2)) return null;
  const guide = activeGuide(), coordinate = point[axis];
  let endpoint, start, pair, selecting = !e.ctrlKey;
  if (selecting) {
    if (point.x < 0 || point.y < 0 || point.x > selected.img.naturalWidth || point.y > selected.img.naturalHeight) return null;
    endpoint = e.button === 2 ? 'moving' : 'fixed';
    const tolerance = guide?.cells ? Math.min(12, Math.abs(guide.moving - guide.fixed) * view.zoom / 3) : 12;
    if (Number.isFinite(guide?.[endpoint]) && Math.abs(coordinate - guide[endpoint]) * view.zoom <= tolerance) {
      start = guide[endpoint]; pair = guide;
    } else {
      const line = nearestGridLine(selected, axis, coordinate), spacing = axis === 'x' ? selected.tile : selected.tileY;
      if (Math.abs(coordinate - line.coordinate) * view.zoom > Math.min(12, spacing * view.zoom * .45)) { notify('请点击网格线附近, 再拖动.'); return null; }
      start = line.coordinate;
      const other = endpoint === 'fixed' ? 'moving' : 'fixed';
      if (Number.isFinite(guide?.[other])) {
        try { pair = endpoint === 'fixed' ? selectedGridPair(selected, axis, start, guide.moving) : selectedGridPair(selected, axis, guide.fixed, start); }
        catch (error) { notify(error.message, true); return null; }
      }
    }
  } else {
    if (!guide) return { kind: 'pan', screen: view.screen(e), x: view.panX, y: view.panY };
    const candidates = ['fixed', 'moving'].filter(key => Number.isFinite(guide[key])).sort((a, b) => Math.abs(coordinate - guide[a]) - Math.abs(coordinate - guide[b]));
    endpoint = candidates[0];
    const tolerance = guide.cells ? Math.min(12, Math.abs(guide.moving - guide.fixed) * view.zoom / 3) : 12;
    if (Math.abs(coordinate - guide[endpoint]) * view.zoom > tolerance) return { kind: 'pan', screen: view.screen(e), x: view.panX, y: view.panY };
    start = guide[endpoint]; pair = guide;
  }
  const tx = { before: snapshot(), key: pickKey(), hadPick: picks.has(pickKey()), pick: structuredClone(picks.get(pickKey())), endpoint, selecting, guide: pair, offset: coordinate - start, lastPoint: point, cancelled: false };
  transaction = tx; activeEnd = endpoint;
  if (e.ctrlKey) setDragMode(tx, true);
  if (selecting) preview(tx, start);
  sync(); view.invalidate(false); return { kind: tx.phaseAxis ? 'phase' : 'line', tx };
}, (point, drag, event) => {
  if (!point || !selected) return;
  $('cursor').textContent = `图片内 X ${point.x.toFixed(2)} · Y ${point.y.toFixed(2)} px`;
  if (!drag || drag.tx.cancelled) return;
  moveDrag(drag.tx, point, event);
}, (drag, event) => {
  const tx = drag.tx; if (tx.cancelled) return;
  if (event.type !== 'pointerup') { cancelDrag(); return; }
  const finalPoint = view.world(view.screen(event));
  moveDrag(tx, finalPoint, event);
  transaction = null;
  if (JSON.stringify(tx.before) !== fingerprint()) history.push(tx.before);
  renderList(); sync(); changed();
}, { rightSelect: true });
async function save() {
  if (!ready || !frames.length) return false;
  const state = snapshot(), key = JSON.stringify(state); $('save').disabled = true;
  try {
    await request('/api/frames', { version: PARAM_VERSION, frames: state }); saved = key;
    if ($('save').classList.contains('retry')) notify('标定已自动保存.');
    $('save').classList.remove('retry'); setSaveState(dirty(), dirty() ? '正在保存新的修改...' : '已自动保存'); return true;
  } catch (e) { notify('自动保存失败: ' + e.message + '. 修改仍保留在此页面.', true); setSaveState(true, '保存失败'); $('save').classList.add('retry'); return false; }
  finally { $('save').disabled = false; }
}
$('save').onclick = () => window.editorBridge.flush().catch(e => notify(e.message, true));
addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  if (mod && key === 's') { e.preventDefault(); window.editorBridge.flush().catch(error => notify(error.message, true)); return; }
  if (transaction && key === 'control') { e.preventDefault(); setDragMode(transaction, true); return; }
  if (editing(e.target)) return;
  if (key === 'escape') { cancelDrag(); return; }
  if (transaction) return;
  if (mod && key === 'z') { e.preventDefault(); (e.shiftKey ? $('redo') : $('undo')).click(); }
  else if (mod && key === 'y') { e.preventDefault(); $('redo').click(); }
  else if (!mod && key === 'f') $('fit').click();
  else if (!mod && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) { e.preventDefault(); nudge(['ArrowLeft', 'ArrowUp'].includes(e.key) ? -1 : 1, e.shiftKey ? 10 : 1); }
});
addEventListener('keyup', e => {
  if (transaction && e.key.toLowerCase() === 'control') { e.preventDefault(); setDragMode(transaction, false); }
});
try {
  const result = await loadFrames(); frames = result.frames; selected = frames[0] || null;
  saved = result.calibrated && !result.changed ? fingerprint() : ''; ready = true;
  renderList(); sync(); changed(); $('empty').hidden = frames.length > 0;
  if (selected) view.fit(boundsOf([local()])); else { setSaveState(false, '等待导入'); $('selection').textContent = '尚未导入截图'; }
  resolveReady();
} catch (e) { notify('加载失败: ' + e.message, true); setSaveState(false, '加载失败'); rejectReady(e); }
