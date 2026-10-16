/* 逐列标注, 吸附预览与自动保存. */
import { $, Autosave, History, Viewport, bindPan, bindViewButtons, boundsOf, drawFrame, editing, installLeaveGuard, loadFrames, notify, request, serializeFrames, setSaveState } from './editor-core.js';
import { inheritObservation, snapPoint } from './observation.js';
const TOOLS = [
  { id: 'block', name: '完整方块', color: '#86e4ad', glyph: '■' },
  { id: 'slopeL', name: '斜坡 左高右低', color: '#ffd185', glyph: '◣' },
  { id: 'slopeR', name: '斜坡 右高左低', color: '#ffa16f', glyph: '◢' },
  { id: 'tree', name: '树木 / 作废', color: '#f49fd3', glyph: '×' },
  { id: 'erase', name: '擦除标记', color: '#a1b2c3', glyph: '⌫' }
];
let frames = [], marks = new Map(), T = 20.86, x0 = 0, marker = 141, tool = 'block', hover = null;
let ready = false, saved = '', grid = .35, markerMode = false, inputBefore = null;
const history = new History(), autosave = new Autosave(save, () => dirty());
let resolveReady, rejectReady;
const whenReady = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; }); whenReady.catch(() => {});
window.editorBridge = { flush: async () => { await whenReady; await autosave.flush(); }, diagnostics: () => ({ ready, marks: marks.size, dirty: dirty(), paints: view.frames, paintMs: view.lastPaintMs }) };
if (parent !== window) document.body.classList.add('embedded');
const snapshot = () => ({ cols: [...marks].map(([c, m]) => ({ c, ...m })).sort((a, b) => a.c - b.c), marker });
const fingerprint = () => JSON.stringify(snapshot());
const dirty = () => ready && fingerprint() !== saved;
const view = new Viewport($('workspace'), (ctx, v) => {
  for (const f of frames) drawFrame(ctx, v, f, { grid });
}, (ctx, v) => {
  const b = v.bounds, radius = 4 / v.zoom;
  if ($('show-marks').checked) {
    for (const [col, m] of marks) {
      const x = x0 + col * T;
      if (x < b.x - T || x > b.right + T || m.y < b.y - 300 || m.y > b.bottom + 300) continue;
      const item = TOOLS.find(t => t.id === m.t) || TOOLS[0]; ctx.fillStyle = item.color; ctx.strokeStyle = item.color; ctx.lineWidth = 2 / v.zoom;
      if (m.t === 'tree') { ctx.globalAlpha = .2; ctx.fillRect(x - T / 2, m.y - 100, T, 200); ctx.globalAlpha = 1; ctx.beginPath(); ctx.moveTo(x - radius, m.y - radius); ctx.lineTo(x + radius, m.y + radius); ctx.moveTo(x + radius, m.y - radius); ctx.lineTo(x - radius, m.y + radius); ctx.stroke(); }
      else if (m.t === 'block') { ctx.fillRect(x - radius, m.y - radius, radius * 2, radius * 2); }
      else { ctx.beginPath(); ctx.moveTo(x - radius * 1.5, m.y + (m.t === 'slopeL' ? -radius : radius)); ctx.lineTo(x + radius * 1.5, m.y + (m.t === 'slopeL' ? radius : -radius)); ctx.stroke(); }
    }
  }
  if ($('show-marker').checked) {
    const x = x0 + marker * T;
    ctx.strokeStyle = '#ffffffb8'; ctx.lineWidth = 1.5 / v.zoom; ctx.setLineDash([6 / v.zoom, 4 / v.zoom]);
    ctx.beginPath(); ctx.moveTo(x, b.y); ctx.lineTo(x, b.bottom); ctx.stroke(); ctx.setLineDash([]);
    ctx.font = `${12 / v.zoom}px sans-serif`; ctx.fillStyle = '#fff'; ctx.fillText(`出生点 ${marker}`, x + 6 / v.zoom, b.y + 65 / v.zoom);
  }
  if (hover) {
    const color = markerMode ? '#fff' : TOOLS.find(t => t.id === tool).color;
    ctx.strokeStyle = color; ctx.lineWidth = 1 / v.zoom; ctx.setLineDash([3 / v.zoom, 3 / v.zoom]);
    ctx.beginPath(); ctx.moveTo(hover.x, b.y); ctx.lineTo(hover.x, b.bottom); ctx.moveTo(b.x, hover.y); ctx.lineTo(b.right, hover.y); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = color; ctx.globalAlpha = .25; ctx.fillRect(hover.x - T / 2, hover.y, T, hover.f.tileY); ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.arc(hover.x, hover.y, 6 / v.zoom, 0, Math.PI * 2); ctx.stroke();
  }
});
bindViewButtons(view, () => frames); installLeaveGuard(dirty);
function stats() {
  const count = { block: 0, slopeL: 0, slopeR: 0, tree: 0 };
  for (const m of marks.values()) if (m.t in count) count[m.t]++;
  $('total').textContent = marks.size; $('valid').textContent = marks.size - count.tree;
  $('stat').textContent = `方块 ${count.block} · 斜坡 ${count.slopeL + count.slopeR} · 作废 ${count.tree}`;
}
function changed() {
  stats(); $('marker').value = marker;
  $('undo').disabled = !history.past.length; $('redo').disabled = !history.future.length;
  $('save').disabled = !ready || !frames.length;
  setSaveState(dirty(), dirty() ? '正在自动保存...' : '已自动保存');
  if (dirty()) { $('diagnostic').textContent = '正在更新观测诊断...'; autosave.schedule(); }
  view.invalidate(false);
}
function restore(value) {
  if (!value) return;
  marks = new Map(value.cols.map(({ c, ...m }) => [c, m])); marker = value.marker; changed();
}
function chooseTool(id) {
  tool = id; markerMode = false; $('pick-marker').setAttribute('aria-pressed', 'false');
  document.querySelectorAll('#tools button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
  $('selection').textContent = `当前工具: ${TOOLS.find(t => t.id === tool).name}`; view.invalidate(false);
}
for (const [index, item] of TOOLS.entries()) {
  const button = document.createElement('button'); button.dataset.tool = item.id; button.style.setProperty('--tool-color', item.color);
  const label = document.createElement('span'); label.textContent = `${item.glyph}  ${item.name}`;
  const key = document.createElement('kbd'); key.textContent = index + 1; button.append(label, key); button.onclick = () => chooseTool(item.id); $('tools').append(button);
}
chooseTool('block');
function pick(point) { return point && snapPoint(point, frames, x0, T); }
function paint(point) {
  if (!point) return;
  if (tool === 'erase') marks.delete(point.col);
  else marks.set(point.col, { y: Math.round(point.y * 1000) / 1000, t: tool });
  view.invalidate(false);
}
bindPan(view, (point, e) => {
  if (!ready || e.button !== 0) return null;
  const p = pick(point); if (!p) return null;
  if (markerMode) { history.push(snapshot()); marker = p.col; markerMode = false; $('pick-marker').setAttribute('aria-pressed', 'false'); changed(); chooseTool(tool); return null; }
  const before = snapshot(); paint(p); hover = p; return { kind: 'paint', before, last: p };
}, (point, drag) => {
  hover = pick(point);
  if (hover) $('cursor').textContent = `列 ${hover.col} · 高度 ${hover.y.toFixed(2)} px · ${hover.f.id}`;
  if (drag && hover) {
    // 连接事件间经过的列, 避免快速拖动时出现漏列.
    const last = drag.last, span = hover.col - last.col;
    if (span && Math.abs(span) < 4000) {
      for (let c = last.col; c !== hover.col; c += Math.sign(span)) {
        const ratio = (c - last.col) / span;
        paint(pick({ x: x0 + c * T, y: last.y + (hover.y - last.y) * ratio }));
      }
    }
    paint(hover); drag.last = hover;
  }
  view.invalidate(false);
}, drag => {
  if (JSON.stringify(drag.before) !== fingerprint()) history.push(drag.before);
  changed();
});
$('undo').onclick = () => restore(history.undo(snapshot())); $('redo').onclick = () => restore(history.redo(snapshot()));
$('grid').oninput = e => { grid = Number(e.target.value); view.invalidate(); };
$('show-marks').onchange = $('show-marker').onchange = () => view.invalidate(false);
$('pick-marker').onclick = () => { markerMode = !markerMode; $('pick-marker').setAttribute('aria-pressed', String(markerMode)); $('selection').textContent = markerMode ? '在图片中点击出生点位置' : `当前工具: ${TOOLS.find(t => t.id === tool).name}`; view.invalidate(false); };
$('marker').onfocus = () => { inputBefore = snapshot(); };
$('marker').onchange = e => {
  if (e.target.value.trim() && e.target.checkValidity()) {
    const next = e.target.valueAsNumber;
    if (Number.isSafeInteger(next) && next >= 0 && next !== marker) { history.push(inputBefore || snapshot()); marker = next; changed(); }
  }
  $('marker').value = marker; inputBefore = null;
};
$('clear').onclick = () => { if (marks.size && confirm('清空全部标记? 可以通过撤销恢复.')) { history.push(snapshot()); marks.clear(); changed(); } };
function showDiagnostic(meta) {
  if (!meta) { $('diagnostic').textContent = '尚无有效观测. 标注地表后会自动生成.'; $('diagnostic').className = 'hint'; return; }
  const rate = meta.step_rate;
  $('diagnostic').textContent = `台阶率 ${rate}% · 有效列 ${meta.valid}. ` + (rate < 3 ? '偏低, 请检查格宽和标注.' : rate > 20 ? '偏高, 请检查标注.' : '可结合地形检查, 出生点附近通常约 9-15%.');
  $('diagnostic').className = 'hint ' + (rate < 3 || rate > 20 ? 'warn' : 'good');
}
async function save() {
  if (!ready || !frames.length) return false;
  const state = snapshot(), key = JSON.stringify(state); $('save').disabled = true;
  try {
    const result = await request('/api/marks', { version: 1, tile: T, x0, frames: serializeFrames(frames), ...state });
    saved = key; showDiagnostic(result.observed);
    if ($('save').classList.contains('retry')) notify('修改已自动保存.');
    setSaveState(dirty(), dirty() ? '正在保存新的修改...' : '已自动保存'); $('save').classList.remove('retry'); return true;
  } catch (e) { notify('自动保存失败: ' + e.message + '. 标记仍保留在此页面, 可点击重试保存.', true); setSaveState(true, '保存失败'); $('save').classList.add('retry'); return false; }
  finally { $('save').disabled = false; }
}
$('save').onclick = () => autosave.flush().catch(() => {});
addEventListener('keydown', e => {
  const key = e.key.toLowerCase(), mod = e.ctrlKey || e.metaKey;
  if (mod && key === 's') { e.preventDefault(); autosave.flush().catch(() => {}); return; }
  if (editing(e.target)) return;
  if (mod && key === 'z') { e.preventDefault(); (e.shiftKey ? $('redo') : $('undo')).click(); }
  else if (mod && key === 'y') { e.preventDefault(); $('redo').click(); }
  else if (!mod && /^[1-5]$/.test(key)) chooseTool(TOOLS[Number(key) - 1].id);
  else if (key === 'escape') chooseTool(tool);
  else if (!mod && key === 'f') $('fit').click();
});
try {
  const result = await loadFrames();
  if (!result.calibrated) { $('empty').hidden = false; setSaveState(false, '等待对齐'); resolveReady(); }
  else {
    frames = result.frames.filter(f => f.on && !f.failed);
    let stored = null;
    try { stored = await request('/data/marks.json'); } catch (e) { if (!e.message.includes('404')) throw e; }
    const inherited = inheritObservation(stored, frames);
    T = inherited.tile; x0 = inherited.x0; marker = inherited.marker;
    marks = new Map(inherited.cols.map(({ c, y, t }) => [c, { y, t }]));
    if (inherited.migrated && marks.size) notify('已继承最新对齐和格宽. 旧标记已换算到新列网格, 请检查它们是否仍与地表对齐.' + (inherited.collisions ? ` 有 ${inherited.collisions} 个标记合并到同一列.` : ''));
    ready = true; saved = inherited.migrated && stored?.cols?.length ? '' : fingerprint(); changed(); $('empty').hidden = frames.length > 0; view.fit(boundsOf(frames));
    try { showDiagnostic(await request('/data/observed_meta.json')); } catch { showDiagnostic(null); }
    if (result.changed) notify('截图列表有变化. 请先在对齐步骤确认新增或删除的图片.');
    resolveReady();
  }
} catch (e) { notify('加载失败: ' + e.message, true); setSaveState(false, '加载失败'); rejectReady(e); }
