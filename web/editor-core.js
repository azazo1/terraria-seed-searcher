/* 画布坐标, 可见区域绘制与操作历史. */
export const $ = id => document.getElementById(id);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const editing = target => !!target?.closest('input,textarea,select,[contenteditable=true]');
export const frameName = src => src.replace(/^\/+/, '').split('/').pop();
export const imageURL = src => '/' + src.replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
export async function request(url, body) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15000), ...(body === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }) });
  const data = await response.json();
  if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
export function notify(message = '', error = false) {
  $('notice').textContent = message;
  $('notice').classList.toggle('error', error);
}
export class History {
  constructor(limit = 100) { this.past = []; this.future = []; this.limit = limit; }
  push(value) { this.past.push(structuredClone(value)); if (this.past.length > this.limit) this.past.shift(); this.future = []; }
  undo(value) { if (!this.past.length) return null; this.future.push(structuredClone(value)); return this.past.pop(); }
  redo(value) { if (!this.future.length) return null; this.past.push(structuredClone(value)); return this.future.pop(); }
}
export function normalizeFrame(f, i) {
  const finite = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
  const tile = clamp(finite(f.tile, 20.86), 1, 512);
  return { id: f.id || `frame${i + 1}`, src: f.src.replace(/^\/+/, ''),
    tile, tileY: clamp(finite(f.tileY, tile), 1, 512),
    phaseX: finite(f.phaseX, 0), phaseY: finite(f.phaseY, 0),
    x: finite(f.x, i * 1200), y: finite(f.y, 0), on: f.on !== false, locked: !!f.locked };
}
export async function loadFrames(fresh = false) {
  const names = await request('/frames');
  let saved = null;
  if (!fresh) { try { saved = await request('/data/param.json'); } catch (e) { if (!e.message.includes('404')) throw e; } }
  const namesSet = new Set(names);
  const frames = (saved?.frames || []).filter(f => namesSet.has(frameName(f.src))).map(normalizeFrame);
  const used = new Set(frames.map(f => frameName(f.src)));
  for (const name of names) {
    if (used.has(name)) continue;
    const i = frames.length;
    let id = `frame${i + 1}`;
    while (frames.some(f => f.id === id)) id += '_';
    frames.push(normalizeFrame({ id, src: 'frames/' + name, x: i * 1200 }, i));
  }
  await Promise.all(frames.map(f => new Promise(resolve => {
    f.img = new Image();
    f.img.onload = () => resolve();
    f.img.onerror = () => { f.failed = true; resolve(); };
    f.img.src = imageURL(f.src);
  })));
  return { frames, calibrated: !!saved, changed: !!saved && (frames.length !== saved.frames.length || used.size !== names.length) };
}
export function serializeFrames(frames) {
  return frames.map(({ img, failed, ...f }) => ({ ...f }));
}
export function boundsOf(frames) {
  const valid = frames.filter(f => f.on !== false && f.img?.naturalWidth);
  if (!valid.length) return null;
  return { x: Math.min(...valid.map(f => f.x)), y: Math.min(...valid.map(f => f.y)),
    right: Math.max(...valid.map(f => f.x + f.img.naturalWidth)), bottom: Math.max(...valid.map(f => f.y + f.img.naturalHeight)) };
}
export function hitFrame(frames, p) {
  return [...frames].reverse().find(f => f.on !== false && f.img?.naturalWidth && p.x >= f.x && p.x <= f.x + f.img.naturalWidth && p.y >= f.y && p.y <= f.y + f.img.naturalHeight);
}
export function gridStart(min, origin, step) { return origin + Math.ceil((min - origin) / step) * step; }
export function drawFrame(ctx, view, f, { opacity = 1, grid = .35, selected = false } = {}) {
  if (f.on === false || !f.img.naturalWidth) return;
  const b = view.bounds, w = f.img.naturalWidth, h = f.img.naturalHeight;
  const x1 = Math.max(f.x, b.x), y1 = Math.max(f.y, b.y), x2 = Math.min(f.x + w, b.right), y2 = Math.min(f.y + h, b.bottom);
  if (x2 <= x1 || y2 <= y1) return;
  ctx.globalAlpha = opacity;
  ctx.drawImage(f.img, x1 - f.x, y1 - f.y, x2 - x1, y2 - y1, x1, y1, x2 - x1, y2 - y1);
  // 每条线都对应一个方块边界, 缩放只改变显示比例, 不省略网格.
  if (grid > 0) {
    ctx.globalAlpha = grid; ctx.lineWidth = 1 / view.zoom;
    const sx = f.tile;
    const sy = f.tileY;
    ctx.strokeStyle = '#ff8292'; ctx.beginPath();
    for (let x = gridStart(x1, f.x + f.phaseX, sx); x <= x2; x += sx) { ctx.moveTo(x, y1); ctx.lineTo(x, y2); }
    ctx.stroke(); ctx.strokeStyle = '#6ed6ff'; ctx.beginPath();
    for (let y = gridStart(y1, f.y + f.phaseY, sy); y <= y2; y += sy) { ctx.moveTo(x1, y); ctx.lineTo(x2, y); }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (selected) { ctx.lineWidth = 2 / view.zoom; ctx.strokeStyle = '#72dfbe'; ctx.strokeRect(f.x, f.y, w, h); }
  ctx.font = `${12 / view.zoom}px sans-serif`; ctx.fillStyle = '#111e2b';
  ctx.fillRect(x1, y1, (ctx.measureText(f.id).width + 12 / view.zoom), 23 / view.zoom);
  ctx.fillStyle = '#e5f7ff'; ctx.fillText(f.id, x1 + 6 / view.zoom, y1 + 16 / view.zoom);
}
export class Viewport {
  constructor(host, paint, overlay = () => {}) {
    this.host = host; this.paint = paint; this.paintOverlay = overlay;
    this.zoom = .5; this.panX = 0; this.panY = 0; this.width = 1; this.height = 1;
    this.canvas = document.createElement('canvas'); this.canvas.setAttribute('aria-label', '截图编辑画布');
    this.overlay = document.createElement('canvas'); this.overlay.setAttribute('aria-label', '编辑操作区域'); this.overlay.tabIndex = 0;
    host.prepend(this.canvas, this.overlay); this.ctx = this.canvas.getContext('2d'); this.octx = this.overlay.getContext('2d');
    this.pending = 0; this.baseDirty = true; this.frames = 0; this.lastPaintMs = 0;
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(host); this.resize();
    this.overlay.addEventListener('wheel', e => {
      e.preventDefault(); const p = this.screen(e); const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.height : 1);
      this.scaleAt(clamp(this.zoom * Math.exp(-delta * .0015), .03, 12), p);
    }, { passive: false });
    this.overlay.addEventListener('contextmenu', e => e.preventDefault());
  }
  get bounds() { return { x: -this.panX / this.zoom, y: -this.panY / this.zoom, right: (this.width - this.panX) / this.zoom, bottom: (this.height - this.panY) / this.zoom }; }
  screen(e) { const r = this.overlay.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  world(p) { return { x: (p.x - this.panX) / this.zoom, y: (p.y - this.panY) / this.zoom }; }
  resize() {
    this.width = Math.max(1, this.host.clientWidth); this.height = Math.max(1, this.host.clientHeight); this.dpr = Math.min(devicePixelRatio || 1, 2);
    for (const c of [this.canvas, this.overlay]) { c.width = Math.round(this.width * this.dpr); c.height = Math.round(this.height * this.dpr); }
    if (this.deferredFit && this.host.clientWidth > 1 && this.host.clientHeight > 1) { const b = this.deferredFit; this.deferredFit = null; this.fit(b); }
    this.invalidate();
  }
  scaleAt(zoom, p = { x: this.width / 2, y: this.height / 2 }) {
    const anchor = this.world(p); this.zoom = clamp(zoom, .03, 12);
    this.panX = p.x - anchor.x * this.zoom; this.panY = p.y - anchor.y * this.zoom; this.invalidate();
  }
  fit(b) {
    if (!b) return;
    if (this.host.clientWidth <= 1 || this.host.clientHeight <= 1) { this.deferredFit = b; return; }
    this.zoom = clamp(Math.min((Math.max(40, this.width - 64)) / Math.max(1, b.right - b.x), (Math.max(40, this.height - 64)) / Math.max(1, b.bottom - b.y)), .03, 4);
    this.panX = (this.width - (b.right + b.x) * this.zoom) / 2;
    this.panY = (this.height - (b.bottom + b.y) * this.zoom) / 2; this.invalidate();
  }
  setup(ctx, clear = false) {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (clear) ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    else { ctx.fillStyle = '#0b1118'; ctx.fillRect(0, 0, this.canvas.width, this.canvas.height); }
    ctx.setTransform(this.dpr * this.zoom, 0, 0, this.dpr * this.zoom, this.dpr * this.panX, this.dpr * this.panY);
    ctx.imageSmoothingEnabled = false;
  }
  invalidate(base = true) {
    this.baseDirty ||= base;
    if (this.pending) return;
    this.pending = requestAnimationFrame(() => {
      this.pending = 0; const started = performance.now();
      if (this.baseDirty) { this.setup(this.ctx); this.paint(this.ctx, this); this.baseDirty = false; }
      this.setup(this.octx, true); this.paintOverlay(this.octx, this);
      this.frames++; this.lastPaintMs = performance.now() - started;
      if ($('zoom')) $('zoom').textContent = `${Math.round(this.zoom * 100)}%`;
    });
  }
}
export function bindViewButtons(view, frames) {
  $('fit').onclick = () => view.fit(boundsOf(frames()));
  $('zoom-in').onclick = () => view.scaleAt(view.zoom * 1.25);
  $('zoom-out').onclick = () => view.scaleAt(view.zoom / 1.25);
  $('actual').onclick = () => view.scaleAt(1);
}
export function bindPan(view, onDown, onMove, onUp) {
  let drag = null, space = false;
  addEventListener('keydown', e => { if (e.code === 'Space' && !editing(e.target)) { space = true; e.preventDefault(); } });
  addEventListener('keyup', e => { if (e.code === 'Space') space = false; });
  const end = e => { if (!drag || (e.pointerId !== undefined && e.pointerId !== drag.pointerId)) return; const old = drag; drag = null; view.overlay.style.cursor = ''; if (old.kind !== 'pan') onUp?.(old); };
  addEventListener('blur', () => { space = false; end({}); });
  view.overlay.addEventListener('pointerdown', e => {
    if (drag) return;
    const screen = view.screen(e), point = view.world(screen);
    const mode = e.button === 1 || e.button === 2 || space ? { kind: 'pan', screen, x: view.panX, y: view.panY } : onDown(point, e);
    if (!mode) return;
    e.preventDefault(); view.overlay.focus({ preventScroll: true }); view.overlay.setPointerCapture(e.pointerId);
    drag = { ...mode, pointerId: e.pointerId }; view.overlay.style.cursor = mode.kind === 'pan' ? 'grabbing' : 'crosshair';
  });
  view.overlay.addEventListener('pointermove', e => {
    const screen = view.screen(e), point = view.world(screen);
    if (drag?.kind === 'pan') { view.panX = drag.x + screen.x - drag.screen.x; view.panY = drag.y + screen.y - drag.screen.y; view.invalidate(); }
    else onMove?.(point, drag, e);
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) view.overlay.addEventListener(name, end);
  view.overlay.addEventListener('pointerleave', e => { if (!drag) onMove?.(null, null, e); });
}
export class Autosave {
  constructor(save, isDirty, delay = 700) { this.save = save; this.isDirty = isDirty; this.delay = delay; this.timer = null; this.running = null; }
  schedule() { clearTimeout(this.timer); this.timer = setTimeout(() => this.flush().catch(() => {}), this.delay); }
  flush() {
    clearTimeout(this.timer);
    if (this.running) return this.running;
    this.running = (async () => {
      while (this.isDirty()) {
        if (!await this.save()) throw new Error('自动保存失败, 请检查连接后重试.');
      }
    })().finally(() => { this.running = null; });
    return this.running;
  }
}
export function setSaveState(dirty, text) {
  $('save-state').dataset.dirty = String(dirty); $('save-state').textContent = text || (dirty ? '有未保存的修改' : '已保存');
}
export function installLeaveGuard(isDirty) {
  addEventListener('beforeunload', e => { if (isDirty()) { e.preventDefault(); e.returnValue = ''; } });
  if (parent !== window) document.addEventListener('click', e => {
    const link = e.target.closest('a[href]'); if (!link) return;
    const url = new URL(link.href, location.href); if (url.origin !== location.origin) return;
    const tab = url.pathname === '/web/calib.html' ? 'calib' : url.pathname === '/web/mark.html' ? 'mark' : url.pathname === '/' ? 'import' : null;
    if (tab) { e.preventDefault(); parent.postMessage({ type: 'terrseed-navigate', tab }, location.origin); }
  });
}
