// 用内存 DOM 验证真实页面模块, 不读取或修改用户标注.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { migrateParam } from '../web/frame-schema.js';
import { DEFAULT_SEARCH_PARAMETERS } from '../web/search-parameters.js';

function environment(html, store) {
  const elements = [], ids = new Map(), events = new Map(), raf = [], draw = [];
  const ctx = new Proxy({}, { get: (_target, key) => key === 'measureText' ? () => ({ width: 20 }) : (...args) => draw.push([key, ...args]), set: () => true });
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.handlers = new Map(); this.attributes = {}; this.dataset = {}; this.style = { setProperty() {} }; this.className = ''; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.clientWidth = 1000; this.clientHeight = 700; this.parentNode = null; elements.push(this); }
    get classList() { return { contains: c => this.className.split(' ').includes(c), add: c => this.className = [...new Set([...this.className.split(' '), c])].join(' '), remove: c => this.className = this.className.split(' ').filter(x => x !== c).join(' '), toggle: (c, on) => { const has = this.className.split(' ').includes(c); this.classList[(on ?? !has) ? 'add' : 'remove'](c); } }; }
    get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
    setAttribute(k, v) { this.attributes[k] = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = String(v); }
    getAttribute(k) { return this.attributes[k]; }
    removeAttribute(k) { delete this.attributes[k]; }
    append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); if (node.tagName === 'IFRAME') { const key = node.src.includes('grid') ? 'grid' : node.src.includes('calib') ? 'calib' : 'mark'; node.contentWindow = { editorBridge: store.editorFactory?.(key) || { flush: async () => {} } }; queueMicrotask(() => node.onload?.()); } } }
    prepend(...nodes) { for (const node of nodes) node.parentNode = this; this.children.unshift(...nodes); }
    replaceChildren(...nodes) { for (const node of this.children) node.parentNode = null; this.children = []; this.append(...nodes); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(n => n !== this); this.parentNode = null; }
    addEventListener(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, []); this.handlers.get(type).push(fn); }
    async fire(type, more = {}) { const e = { type, target: this, currentTarget: this, button: 0, pointerId: 1, clientX: 250, clientY: 250, preventDefault() {}, stopPropagation() {}, ...more }; if (this['on' + type]) await this['on' + type](e); for (const fn of this.handlers.get(type) || []) await fn(e); }
    click() { if (!this.disabled) return this.fire('click'); }
    focus() { doc.activeElement = this; }
    checkValidity() { const n = this.valueAsNumber; return Number.isFinite(n) && (this.min === undefined || n >= Number(this.min)) && (this.max === undefined || n <= Number(this.max)); }
    reportValidity() { return this.checkValidity(); }
    closest(selector) { return selector.split(',').some(s => s === this.tagName.toLowerCase() || s === '[contenteditable=true]' && this.attributes.contenteditable === 'true' || s === 'a[href]' && this.tagName === 'A') ? this : this.parentNode?.closest(selector); }
    getBoundingClientRect() { return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight }; }
    getContext() { return ctx; }
    setPointerCapture() {}
  }
  const body = new Element('body');
  for (const match of html.matchAll(/<([a-z][\w-]*)([^>]*)>/gi)) {
    const [, tag, attrs] = match; if (tag === 'body' || tag === 'html') continue;
    const el = new Element(tag);
    for (const a of attrs.matchAll(/([\w-]+)="([^"]*)"/g)) {
      const [, key, value] = a; el.setAttribute(key, value);
      if (key === 'id') ids.set(value, el);
      if (['id', 'value', 'min', 'max', 'class'].includes(key)) el[key === 'class' ? 'className' : key] = value;
    }
    el.checked = /\bchecked\b/.test(attrs); el.disabled = /\bdisabled\b/.test(attrs); body.append(el);
  }
  const doc = { body, activeElement: body, getElementById: id => ids.get(id) || null, createElement: tag => new Element(tag), addEventListener: (name, fn) => { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); }, querySelectorAll: selector => {
    if (selector === '[data-dx]') return elements.filter(e => e.dataset.dx !== undefined);
    if (selector === '#tools button') return ids.get('tools').children;
    if (selector === '[data-tab]') return elements.filter(e => e.dataset.tab !== undefined);
    return [];
  } };
  ids.get('nudge-step') && (ids.get('nudge-step').value = '1');
  ids.get('line-step') && (ids.get('line-step').value = '0.1');
  class Image { constructor() { this.naturalWidth = 1800; this.naturalHeight = 1000; } set src(v) { this.url = v; queueMicrotask(() => this.onload?.()); } }
  const post = [];
  const fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      const data = JSON.parse(options.body); post.push({ url, data });
      if (store.fail) return { ok: false, status: 503, json: async () => ({ error: 'offline' }) };
      if (url === '/api/frames') store.param = structuredClone(data);
      if (url === '/api/marks') store.marks = structuredClone(data);
      if (url === '/api/observation') {
        store.observation = structuredClone(data); store.observed = { columns: data.heights.length, valid: data.heights.filter(y => y !== -999).length, marker: data.marker, source: 'import', step_rate: 10 };
      }
      if (url === '/api/task/start' || url === '/api/task/resume') {
        const task = url.endsWith('/resume') ? store.tasks.find(task => task.id === data.id) : { id: 'synthetic-task', backend: data.backend, parameters: data.parameters, next: data.parameters.range[0], status: 'paused', progress: { status: 'stopped', scanned: 0, total: data.parameters.range[1] - data.parameters.range[0], elapsed: 0 }, compatible: true, version: '1' };
        store.tasks = [task];
        return { ok: true, json: async () => ({ task, observation: store.observation, parameters: task.parameters, owner: 'synthetic-owner', rows: [], elapsed: 0, matched: 0 }) };
      }
      if (url === '/api/task/delete') {
        store.tasks = (store.tasks || []).filter(task => task.id !== data.id);
        return { ok: true, json: async () => ({ ok: true, deleted: data.id }) };
      }
      return { ok: true, json: async () => ({ ok: true, observed: data.cols?.length ? { valid: data.cols.length, step_rate: 10 } : null }) };
    }
    if (store.readFailure?.url === url) return { ok: false, status: store.readFailure.status, json: async () => ({ error: store.readFailure.error }) };
    const data = url === '/api/state' ? { frames: store.names, param: store.param, marks: { columns: store.marks?.cols?.length || 0 }, observed: store.observed || null, tasks: store.tasks || [], searcher_built: !!store.searcher_built, cpu_searcher_built: !!store.cpu_searcher_built, mlx_searcher_built: !!store.mlx_searcher_built, searcher_paths: store.searcher_paths, sweep: { running: !!store.running, candidates: 0, ...store.sweep } } : url === '/api/observation' ? store.observation : url.startsWith('/api/sweep/log') ? { log: '' } : url.startsWith('/api/candidates') ? { rows: store.candidates || [] } : url === '/frames' ? store.names : url === '/data/param.json' ? store.param : url === '/data/marks.json' ? store.marks : null;
    return { ok: !!data, status: data ? 200 : 404, json: async () => structuredClone(data || { error: 'not found: ' + url.split('/').pop() }) };
  };
  const names = ['document', 'Image', 'fetch', 'window', 'parent', 'location', 'ResizeObserver', 'devicePixelRatio', 'requestAnimationFrame', 'addEventListener', 'confirm', 'history', 'setInterval'];
  const before = new Map(names.map(k => [k, globalThis[k]]));
  Object.assign(globalThis, { document: doc, Image, fetch, window: globalThis, parent: globalThis, location: new URL('http://localhost/web/calib.html'), history: { replaceState(_state, _title, url) { globalThis.location.hash = url; } }, setInterval: () => 0, ResizeObserver: class { observe() {} }, devicePixelRatio: 1, requestAnimationFrame: fn => { raf.push(fn); return raf.length; }, addEventListener: doc.addEventListener, confirm: () => true });
  return { ids, elements, post, doc, raf, draw, events, restore() { for (const [key, value] of before) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } delete globalThis.editorBridge; } };
}

test('拼接页面继承网格, 锁定阻止拖动, 重排与撤销不重置标定', async () => {
  const calibrated = { id: 'a', src: 'frames/测试 50%.png', tile: 21.25, tileY: 21.25, x: 0, y: 0, phaseX: 3, phaseY: 7, gridCalibrated: true, gridGuides: { x: { fixed: 109.25, moving: 1171.75, cells: 50 } } };
  const store = { names: ['测试 50%.png'], param: { version: 2, frames: [calibrated] } };
  const env = environment(await readFile(new URL('../web/calib.html', import.meta.url), 'utf8'), store);
  try {
    await import('../web/calib.js?ui-calib');
    const get = id => env.ids.get(id);
    assert.equal(get('frames').children.length, 1); assert.equal(get('inspector').hidden, false);
    await globalThis.editorBridge.flush(); assert.equal(store.param.frames.length, 1);
    const x = get('x'); env.doc.activeElement = x; await x.fire('focus'); x.value = '123.4'; await x.fire('input'); await x.fire('change'); env.doc.activeElement = env.doc.body;
    await globalThis.editorBridge.flush(); assert.equal(store.param.frames[0].x, 123.4);
    get('locked').checked = true; await get('locked').fire('change'); await globalThis.editorBridge.flush();
    assert.equal(store.param.frames[0].locked, true); assert.equal(x.disabled, true);
    const overlay = env.elements.filter(e => e.tagName === 'CANVAS').at(-1);
    await get('actual').click();
    await overlay.fire('pointerdown', { clientX: 500, clientY: 300 });
    await overlay.fire('pointermove', { clientX: 600, clientY: 350 }); await overlay.fire('pointerup');
    await globalThis.editorBridge.flush(); assert.equal(store.param.frames[0].x, 123.4);
    get('locked').checked = false; await get('locked').fire('change');
    await get('undo').click(); await globalThis.editorBridge.flush(); assert.equal(store.param.frames[0].locked, true);
    await get('redo').click(); await globalThis.editorBridge.flush(); assert.equal(store.param.frames[0].locked, false);
    await get('reset').click(); await globalThis.editorBridge.flush();
    assert.equal(store.param.frames[0].tile, 21.25); assert.equal(store.param.frames[0].phaseX, 3);
    assert.deepEqual(store.param.frames[0].gridGuides, calibrated.gridGuides); assert.equal(get('tile'), undefined);
    while (env.raf.length) env.raf.shift()();
    assert.ok(globalThis.editorBridge.diagnostics().paints >= 1);
  } finally { env.restore(); }
});

test('拼接可按比例或尺寸等比缩放, 匹配参考格宽, 保存撤销并受锁定保护', async () => {
  const original = { id: 'a', src: 'frames/a.png', tile: 10, tileY: 10, x: 100, y: 200, phaseX: 2, phaseY: 3, gridCalibrated: true, gridGuides: { x: { fixed: 102, moving: 602, cells: 50 } } };
  const store = { names: ['a.png', 'b.png'], param: { version: 2, frames: [original, { id: 'b', src: 'frames/b.png', tile: 20, tileY: 20, x: 3000 }] } };
  const env = environment(await readFile(new URL('../web/calib.html', import.meta.url), 'utf8'), store);
  try {
    await import('../web/calib.js?ui-calib-scale');
    const bridge = globalThis.editorBridge, get = id => env.ids.get(id);
    const set = async (id, value) => { const input = get(id); env.doc.activeElement = input; await input.fire('focus'); input.value = value; await input.fire('input'); await input.fire('change'); env.doc.activeElement = env.doc.body; await input.fire('blur'); await bridge.flush(); };
    await set('scale', '200');
    assert.equal(store.param.frames[0].scale, 2); assert.equal(Number(get('width').value), 3600); assert.equal(Number(get('height').value), 2000);
    assert.equal(store.param.frames[0].x, 100); assert.equal(store.param.frames[0].y, 200); assert.equal(store.param.frames[0].tile, 10); assert.deepEqual(store.param.frames[0].gridGuides, original.gridGuides);
    await get('undo').click(); await bridge.flush(); assert.equal(store.param.frames[0].scale, 1);
    await get('redo').click(); await bridge.flush(); assert.equal(store.param.frames[0].scale, 2);
    await set('width', '5400'); assert.equal(store.param.frames[0].scale, 3); assert.equal(Number(get('height').value), 3000);
    await set('height', '500'); assert.equal(store.param.frames[0].scale, .5); assert.equal(Number(get('width').value), 900);
    await get('match-scale').click(); await bridge.flush(); assert.equal(store.param.frames[0].scale, 2);
    for (const invalid of ['', '0', 'NaN', '10001']) { await set('scale', invalid); assert.equal(store.param.frames[0].scale, 2); }
    get('locked').checked = true; await get('locked').fire('change'); assert.equal(get('scale').disabled, true); assert.equal(get('width').disabled, true); assert.equal(get('match-scale').disabled, true);
    await set('scale', '300'); assert.equal(store.param.frames[0].scale, 2);
    get('locked').checked = false; await get('locked').fire('change'); await get('reset-scale').click(); await bridge.flush(); assert.equal(store.param.frames[0].scale, 1);
  } finally { env.restore(); }
});

test('左右键拖选松开才确认, 两端互相固定, 可换线并取消未确认拖动', async () => {
  const frame = { id: 'a', src: 'frames/a.png', x: 700, y: 90, tile: 20, tileY: 20, phaseX: 0, phaseY: 0, on: true };
  const store = { names: ['a.png'], param: { version: 1, frames: [frame] } };
  const env = environment(await readFile(new URL('../web/grid.html', import.meta.url), 'utf8'), store);
  try {
    await import('../web/grid.js?ui-grid');
    const get = id => env.ids.get(id), overlay = env.elements.filter(e => e.tagName === 'CANVAS').at(-1);
    const bridge = globalThis.editorBridge, diagnostics = () => bridge.diagnostics();
    const point = (x, y = 500) => { const d = diagnostics(); return { clientX: d.panX + x * d.zoom, clientY: d.panY + y * d.zoom }; };
    const drag = async (from, to, button = 0) => { await overlay.fire('pointerdown', { ...point(from), button }); await overlay.fire('pointermove', point(to)); await overlay.fire('pointerup', { ...point(to), button }); };
    const escape = async () => { for (const fn of env.events.get('keydown') || []) await fn({ key: 'Escape', target: overlay, preventDefault() {} }); };
    const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
    assert.equal(diagnostics().guide, null);
    await bridge.flush(); const posts = env.post.length;
    await overlay.fire('pointerdown', { ...point(100) }); await overlay.fire('pointermove', point(110));
    near(diagnostics().guide.fixed, 110); assert.equal(diagnostics().selecting, true);
    await assert.rejects(bridge.flush());
    await new Promise(resolve => setTimeout(resolve, 730)); assert.equal(env.post.length, posts);
    await overlay.fire('pointerup', point(110)); await bridge.flush();
    assert.equal(diagnostics().selecting, false); near(store.param.frames[0].phaseX, 10);
    await drag(1110, 1210, 2); await bridge.flush();
    let saved = store.param.frames[0];
    assert.equal(saved.gridGuides.x.cells, 50); near(saved.tile, 22); near(saved.gridGuides.x.fixed, 110); near(saved.gridGuides.x.moving, 1210);
    await drag(110, 210); await bridge.flush();
    saved = store.param.frames[0]; near(saved.tile, 20); near(saved.gridGuides.x.fixed, 210); near(saved.gridGuides.x.moving, 1210);
    await get('undo').click(); await bridge.flush(); near(store.param.frames[0].tile, 22); near(store.param.frames[0].gridGuides.x.fixed, 110);
    await get('redo').click(); await bridge.flush(); near(store.param.frames[0].tile, 20);
    await drag(1210, 1310, 2); await bridge.flush();
    saved = store.param.frames[0]; near(saved.tile, 22); near(saved.gridGuides.x.fixed, 210); near(saved.gridGuides.x.moving, 1310);
    await drag(430, 450); await bridge.flush();
    saved = store.param.frames[0]; near(saved.tile, 21.5); near(saved.gridGuides.x.fixed, 450); near(saved.gridGuides.x.moving, 1310); assert.equal(saved.gridGuides.x.cells, 40);
    const confirmed = structuredClone(saved), confirmedGuide = structuredClone(diagnostics().guide);
    await overlay.fire('pointerdown', { ...point(880), button: 2 }); await overlay.fire('pointermove', point(900));
    await escape(); await overlay.fire('pointerup', { ...point(900), button: 2 }); await bridge.flush();
    assert.deepEqual(store.param.frames[0], confirmed); assert.deepEqual(diagnostics().guide, confirmedGuide);
    await overlay.fire('pointerdown', point(450)); await overlay.fire('pointermove', point(460)); await overlay.fire('pointercancel', point(460)); await bridge.flush();
    assert.deepEqual(store.param.frames[0], confirmed);
    await drag(450, 1400); await bridge.flush(); near(store.param.frames[0].gridGuides.x.moving, 1310); assert.ok(store.param.frames[0].gridGuides.x.fixed < 1310);
    const zoom = diagnostics().zoom;
    await get('focus-fixed').click(); assert.equal(diagnostics().zoom, zoom);
    await get('axis-y').click(); get('square').checked = false; await get('reselect').click();
    await overlay.fire('pointerdown', { ...point(300, 80) }); await overlay.fire('pointermove', point(300, 90)); await overlay.fire('pointerup', point(300, 90));
    await overlay.fire('pointerdown', { ...point(300, 305), button: 2 }); await overlay.fire('pointermove', point(300, 390)); await overlay.fire('pointerup', { ...point(300, 390), button: 2 }); await bridge.flush();
    near(store.param.frames[0].tileY, 30); near(store.param.frames[0].gridGuides.y.fixed, 90);
    await overlay.fire('pointerdown', point(300, 90)); await overlay.fire('pointermove', point(300, 100)); await overlay.fire('pointerup', point(300, 100)); await bridge.flush();
    saved = store.param.frames[0]; near(saved.tileY, 29); near(saved.gridGuides.y.moving, 390); near(saved.gridGuides.y.fixed, 100);
    await get('reselect').click();
    await overlay.fire('pointerdown', { ...point(300, 390), button: 2 }); await overlay.fire('pointermove', point(300, 400)); await overlay.fire('pointerup', { ...point(300, 400), button: 2 });
    assert.equal(diagnostics().guide.fixed, undefined); near(diagnostics().guide.moving, 400);
    await overlay.fire('pointerdown', { ...point(300, 110) }); await overlay.fire('pointermove', point(300, 120)); await overlay.fire('pointerup', point(300, 120)); await bridge.flush();
    near(store.param.frames[0].gridGuides.y.fixed, 120); near(store.param.frames[0].gridGuides.y.moving, 400); near(store.param.frames[0].tileY, 28);
    assert.equal(saved.x, 700); assert.equal(saved.y, 90);
  } finally { env.restore(); }
});

test('修改间隔保持两端位置, Ctrl 拖动所选线只调整相位, 中键平移视图', async () => {
  const frame = { id: 'a', src: 'frames/a.png', x: 700, y: 90, tile: 20, tileY: 20, phaseX: 0, phaseY: 0, on: true, gridGuides: { x: { fixed: 100, moving: 1100, cells: 50 }, y: { fixed: 80, moving: 280, cells: 10 } } };
  const store = { names: ['a.png'], param: { version: 2, frames: [frame] } };
  const env = environment(await readFile(new URL('../web/grid.html', import.meta.url), 'utf8'), store);
  try {
    await import('../web/grid.js?ui-grid-phase');
    const get = id => env.ids.get(id), overlay = env.elements.filter(e => e.tagName === 'CANVAS').at(-1), bridge = globalThis.editorBridge;
    const point = (x, y = 500) => { const d = bridge.diagnostics(); return { clientX: d.panX + x * d.zoom, clientY: d.panY + y * d.zoom }; };
    const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
    get('cells').value = '40'; await get('cells').fire('change'); await bridge.flush();
    let f = store.param.frames[0]; near(f.tile, 25); near(f.tileY, 25); near(f.gridGuides.x.fixed, 100); near(f.gridGuides.x.moving, 1100); assert.equal(f.gridGuides.x.cells, 40);
    await get('undo').click(); await bridge.flush(); near(store.param.frames[0].tile, 20);
    await get('redo').click(); await bridge.flush(); near(store.param.frames[0].tile, 25);
    const good = structuredClone(store.param);
    for (const value of ['0', '1.5', '', '100001', '100000']) { get('cells').value = value; await get('cells').fire('change'); await bridge.flush(); assert.deepEqual(store.param, good); }
    await overlay.fire('pointerdown', { ...point(100), ctrlKey: true }); await overlay.fire('pointermove', { ...point(113, 550), ctrlKey: true }); await assert.rejects(bridge.flush()); await overlay.fire('pointerup', { ...point(113, 550), ctrlKey: true }); await bridge.flush();
    f = store.param.frames[0]; near(f.tile, 25); near(f.tileY, 25); near(f.phaseX, 13); near(f.phaseY, good.frames[0].phaseY); near(f.gridGuides.x.fixed, 113); near(f.gridGuides.x.moving, 1113); assert.equal(f.gridGuides.x.cells, 40);
    await overlay.fire('pointerdown', { ...point(113), ctrlKey: true }); await overlay.fire('pointermove', { ...point(120), ctrlKey: true }); await overlay.fire('pointerup', { ...point(120), ctrlKey: true }); await bridge.flush();
    f = store.param.frames[0]; near(f.gridGuides.x.fixed, 120); near(f.gridGuides.x.moving, 1120); near(f.phaseX, 20); near(f.tile, 25); assert.equal(f.gridGuides.x.cells, 40);
    const confirmed = structuredClone(store.param);
    await overlay.fire('pointerdown', { ...point(120), ctrlKey: true }); await overlay.fire('pointermove', point(130)); await overlay.fire('pointercancel', point(130)); await bridge.flush(); assert.deepEqual(store.param, confirmed);
    const oldPan = bridge.diagnostics().panX;
    await overlay.fire('pointerdown', { ...point(120), button: 1 }); const end = point(140); await overlay.fire('pointermove', end); await overlay.fire('pointerup', { ...end, button: 1 }); await bridge.flush();
    assert.notEqual(bridge.diagnostics().panX, oldPan); assert.deepEqual(store.param, confirmed);
    let prevented = false; await overlay.fire('contextmenu', { preventDefault() { prevented = true; } }); assert.equal(prevented, true);
    await get('axis-y').click();
    await overlay.fire('pointerdown', { ...point(300, 80), ctrlKey: true }); await overlay.fire('pointermove', { ...point(350, 90), ctrlKey: true }); await overlay.fire('pointerup', { ...point(350, 90), ctrlKey: true }); await bridge.flush();
    f = store.param.frames[0]; near(f.gridGuides.y.fixed, 90); near(f.gridGuides.y.moving, 340); near(f.tileY, 25); near(f.gridGuides.x.fixed, 120); near(f.tile, 25);
    await get('undo').click(); await bridge.flush(); assert.deepEqual(store.param, confirmed);
    await get('redo').click(); await bridge.flush(); near(store.param.frames[0].gridGuides.y.fixed, 90);
  } finally { env.restore(); }
});

test('拖动中按下和松开 Ctrl 即时切换相位模式, 两端不跳动且可整体撤销', async () => {
  const frame = { id: 'a', src: 'frames/a.png', x: 0, y: 0, tile: 20, tileY: 20, phaseX: 0, phaseY: 0, on: true, locked: false, gridCalibrated: false, gridGuides: { x: { fixed: 100, moving: 1100, cells: 50 } } };
  const store = { names: ['a.png'], param: { version: 2, frames: [frame] } };
  const env = environment(await readFile(new URL('../web/grid.html', import.meta.url), 'utf8'), store);
  try {
    await import('../web/grid.js?ui-grid-modifier');
    const overlay = env.elements.filter(e => e.tagName === 'CANVAS').at(-1), bridge = globalThis.editorBridge;
    const point = x => { const d = bridge.diagnostics(); return { clientX: d.panX + x * d.zoom, clientY: d.panY + 500 * d.zoom }; };
    const key = async (type, ctrlKey) => { for (const fn of env.events.get(type) || []) await fn({ key: 'Control', ctrlKey, target: overlay, preventDefault() {} }); };
    const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
    await bridge.flush(); const before = migrateParam(store.param);
    await overlay.fire('pointerdown', point(100)); await overlay.fire('pointermove', { ...point(120), ctrlKey: false });
    await key('keydown', true);
    assert.equal(bridge.diagnostics().dragMode, 'phase');
    await overlay.fire('pointermove', { ...point(140), ctrlKey: true });
    near(bridge.diagnostics().guide.fixed, 140); near(bridge.diagnostics().guide.moving, 1120);
    await key('keyup', false); assert.equal(bridge.diagnostics().dragMode, 'spacing');
    await overlay.fire('pointermove', { ...point(150), ctrlKey: false }); await overlay.fire('pointerup', { ...point(150), ctrlKey: false }); await bridge.flush();
    near(store.param.frames[0].tile, 19.4); near(store.param.frames[0].gridGuides.x.moving, 1120);
    await env.ids.get('undo').click(); await bridge.flush(); assert.deepEqual(store.param, before);
    await overlay.fire('pointerdown', { ...point(1100), button: 2, ctrlKey: true });
    await overlay.fire('pointermove', { ...point(1120), button: 2, ctrlKey: true }); await overlay.fire('pointerup', { ...point(1120), button: 2, ctrlKey: true }); await bridge.flush();
    near(store.param.frames[0].tile, 20); near(store.param.frames[0].gridGuides.x.fixed, 120); near(store.param.frames[0].gridGuides.x.moving, 1120);
    await overlay.fire('pointerdown', point(120));
    await overlay.fire('pointermove', { ...point(130), ctrlKey: true });
    near(bridge.diagnostics().guide.fixed, 130); near(bridge.diagnostics().guide.moving, 1130);
    await overlay.fire('pointercancel', point(130)); await bridge.flush(); near(store.param.frames[0].gridGuides.x.fixed, 120);
  } finally { env.restore(); }
});

test('macOS Firefox 只有 Ctrl mousedown 时仍能平移, 鼠标与指针事件不重复启动', async () => {
  const frame = { id: 'a', src: 'frames/a.png', x: 0, y: 0, tile: 20, tileY: 20, phaseX: 0, phaseY: 0, on: true, gridGuides: { x: { fixed: 100, moving: 1100, cells: 50 } } };
  const store = { names: ['a.png'], param: { version: 2, frames: [frame] } };
  const env = environment(await readFile(new URL('../web/grid.html', import.meta.url), 'utf8'), store);
  try {
    await import('../web/grid.js?ui-grid-firefox-ctrl');
    const overlay = env.elements.filter(e => e.tagName === 'CANVAS').at(-1), bridge = globalThis.editorBridge;
    const point = x => { const d = bridge.diagnostics(); return { clientX: d.panX + x * d.zoom, clientY: d.panY + 500 * d.zoom }; };
    const mouseWindow = async (type, x, extra = {}) => {
      const e = { type, ...point(x), button: 2, buttons: type === 'mouseup' ? 0 : 1, ctrlKey: true, preventDefault() {}, ...extra };
      for (const fn of env.events.get(type) || []) await fn(e);
    };
    const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
    let captures = 0; overlay.setPointerCapture = () => captures++;
    await overlay.fire('mousedown', { ...point(100), pointerId: undefined, ctrlKey: true, button: 2, buttons: 1 });
    assert.equal(bridge.diagnostics().dragMode, 'phase'); assert.equal(captures, 0);
    await mouseWindow('mousemove', 130); near(bridge.diagnostics().guide.fixed, 130); near(bridge.diagnostics().guide.moving, 1130);
    await assert.rejects(bridge.flush());
    await mouseWindow('mouseup', 140); await bridge.flush();
    near(store.param.frames[0].tile, 20); near(store.param.frames[0].gridGuides.x.fixed, 140); near(store.param.frames[0].gridGuides.x.moving, 1140);
    await env.ids.get('undo').click(); await bridge.flush(); near(store.param.frames[0].gridGuides.x.fixed, 100);
    await overlay.fire('pointerdown', { ...point(100), ctrlKey: true });
    await overlay.fire('mousedown', { ...point(1100), pointerId: undefined, ctrlKey: true, button: 2, buttons: 1 });
    await overlay.fire('pointermove', { ...point(120), ctrlKey: true }); await overlay.fire('pointerup', { ...point(120), ctrlKey: true });
    await mouseWindow('mouseup', 120); await bridge.flush();
    near(store.param.frames[0].gridGuides.x.fixed, 120); near(store.param.frames[0].gridGuides.x.moving, 1120);
    await env.ids.get('undo').click(); await bridge.flush(); near(store.param.frames[0].gridGuides.x.fixed, 100);
    await overlay.fire('mousedown', { ...point(1100), pointerId: undefined, ctrlKey: true, button: 2, buttons: 1 });
    await mouseWindow('mousemove', 1120);
    await overlay.fire('pointerup', { ...point(1120), ctrlKey: true, button: 2, buttons: 0 }); await mouseWindow('mouseup', 1120); await bridge.flush();
    near(store.param.frames[0].gridGuides.x.fixed, 120); near(store.param.frames[0].gridGuides.x.moving, 1120);
    await overlay.fire('mousedown', { ...point(120), pointerId: undefined, ctrlKey: true, button: 2, buttons: 1 });
    await mouseWindow('mousemove', 140);
    for (const fn of env.events.get('blur') || []) await fn({ type: 'blur' });
    await mouseWindow('mouseup', 140); await bridge.flush(); near(store.param.frames[0].gridGuides.x.fixed, 120);
  } finally { env.restore(); }
});

test('首次没有标注文件仍可开始, 预览只占一格并居中, 连续标注保存上边缘', async () => {
  const frame = { id: 'a', src: 'frames/a.png', x: 100, y: 200, tile: 9.5, tileY: 9.5, phaseX: 2.25, phaseY: 4.125, on: true };
  const store = { names: ['a.png'], param: { version: 2, frames: [frame] } };
  const env = environment(await readFile(new URL('../web/mark.html', import.meta.url), 'utf8'), store);
  try {
    await import('../web/mark.js?ui-mark-first-run');
    const bridge = globalThis.editorBridge, overlay = env.elements.filter(e => e.tagName === 'CANVAS').at(-1);
    await bridge.flush(); assert.equal(bridge.diagnostics().ready, true); assert.equal(bridge.diagnostics().tile, 9.5); assert.equal(env.post.length, 0);
    const point = (x, y) => { const d = bridge.diagnostics(); return { clientX: d.panX + x * d.zoom, clientY: d.panY + y * d.zoom }; };
    const left = 140.25, top = 261.125, center = { x: 145, y: 265.875 };
    await overlay.fire('pointermove', point(left + .5, top + .5));
    env.draw.length = 0; while (env.raf.length) env.raf.shift()();
    assert.ok(env.draw.some(c => c[0] === 'fillRect' && c[1] === left && c[2] === top && c[3] === 9.5 && c[4] === 9.5));
    assert.ok(env.draw.some(c => c[0] === 'arc' && c[1] === center.x && c[2] === center.y));
    await overlay.fire('pointerdown', point(left + .5, top + .5));
    await overlay.fire('pointermove', point(center.x + 3 * frame.tile, center.y));
    await overlay.fire('pointerup', point(center.x + 3 * frame.tile, center.y)); await bridge.flush();
    assert.deepEqual(store.marks.cols.map(m => m.c), [4, 5, 6, 7]);
    for (const m of store.marks.cols) { assert.equal(m.y, top); assert.equal(m.t, 'block'); }
    assert.equal(store.marks.tile, frame.tile);
    await env.ids.get('undo').click(); await bridge.flush(); assert.equal(store.marks.cols.length, 0);
    await env.ids.get('redo').click(); await bridge.flush(); assert.equal(store.marks.cols.length, 4);
  } finally { env.restore(); }
});

test('标注继承单图缩放, 保存原像素锚点并在再次缩放后跟随', async () => {
  const frame = { id: 'a', src: 'frames/a.png', x: 100, y: 200, tile: 10, tileY: 10, phaseX: 2, phaseY: 3, scale: 2, on: true };
  const store = { names: ['a.png'], param: migrateParam({ version: 2, frames: [frame] }) };
  const html = await readFile(new URL('../web/mark.html', import.meta.url), 'utf8');
  let env = environment(html, store);
  try {
    await import('../web/mark.js?ui-mark-scaled');
    const bridge = globalThis.editorBridge, overlay = env.elements.filter(e => e.tagName === 'CANVAS').at(-1), d = bridge.diagnostics();
    assert.equal(d.tile, 20); assert.equal(d.x0, 104);
    const point = { clientX: d.panX + 174 * d.zoom, clientY: d.panY + 296 * d.zoom };
    await overlay.fire('pointerdown', point); await overlay.fire('pointerup', point); await bridge.flush();
    assert.deepEqual(store.marks.cols[0], { c: 3, y: 286, t: 'block', frameId: 'a', imageX: 37, imageY: 43 });
  } finally { env.restore(); }
  store.param.frames[0].scale = .5; env = environment(html, store);
  try {
    await import('../web/mark.js?ui-mark-rescaled'); await globalThis.editorBridge.flush();
    assert.equal(store.marks.tile, 5); assert.equal(store.marks.cols[0].c, 3); assert.equal(store.marks.cols[0].y, 221.5);
    assert.equal(store.marks.cols[0].imageX, 37); assert.equal(store.marks.cols[0].imageY, 43);
  } finally { env.restore(); }
});

test('标注页网格大差距仅警示, 小差距和缩放一致时不提示且仍可保存', async () => {
  const cases = [{ scale: 1, on: true, warning: true }, { scale: .5, on: true, warning: false }, { scale: .52, on: true, warning: false }, { scale: 1, on: false, warning: false }];
  const html = await readFile(new URL('../web/mark.html', import.meta.url), 'utf8');
  for (const [index, item] of cases.entries()) {
    const store = { names: ['a.png', 'b.png'], param: migrateParam({ version: 2, frames: [{ id: 'a', src: 'frames/a.png', tile: 10, tileY: 10, x: 0, y: 0 }, { id: 'b', src: 'frames/b.png', tile: 20, tileY: 20, x: 3000, scale: item.scale, on: item.on }] }) };
    const env = environment(html, store);
    try {
      await import(`../web/mark.js?ui-mark-warning-${index}`);
      const bridge = globalThis.editorBridge; await bridge.flush();
      assert.equal(env.ids.get('grid-warning').hidden, !item.warning); assert.equal(bridge.diagnostics().ready, true);
      if (item.warning) {
        const d = bridge.diagnostics(), overlay = env.elements.filter(e => e.tagName === 'CANVAS').at(-1);
        const point = { clientX: d.panX + 25 * d.zoom, clientY: d.panY + 45 * d.zoom };
        await overlay.fire('pointerdown', point); await overlay.fire('pointerup', point); await bridge.flush();
        assert.equal(store.marks.cols[0].c, 2); assert.equal(store.marks.cols[0].y, 40); assert.equal(env.ids.get('grid-warning').hidden, false);
      }
    } finally { env.restore(); }
  }
});

test('真实读取错误不能作为缺少标注文件忽略', async () => {
  const store = { names: ['a.png'], param: { version: 2, frames: [{ id: 'a', src: 'frames/a.png', tile: 10 }] }, readFailure: { url: '/data/marks.json', status: 503, error: 'storage error 404' } };
  const env = environment(await readFile(new URL('../web/mark.html', import.meta.url), 'utf8'), store);
  try {
    await import('../web/mark.js?ui-mark-read-failed');
    await assert.rejects(globalThis.editorBridge.flush(), e => e.status === 503);
    assert.equal(globalThis.editorBridge.diagnostics().ready, false); assert.equal(env.post.length, 0);
  } finally { env.restore(); }
});

test('简化工具后旧斜坡自动转方块且高度不变, 数字 2 作废和数字 3 擦除仍可撤销', async () => {
  const frame = migrateParam({ version: 2, frames: [{ id: 'a', src: 'frames/a.png', tile: 10, tileY: 10, x: 0, y: 0 }] }).frames[0];
  const cols = [{ c: 0, y: 30, t: 'slopeL' }, { c: 1, y: 50, t: 'slopeR' }, { c: 2, y: 70, t: 'tree' }];
  const store = { names: ['a.png'], param: migrateParam({ version: 2, frames: [frame] }), marks: { version: 1, tile: 10, x0: 0, marker: 1, frames: [frame], cols } };
  const env = environment(await readFile(new URL('../web/mark.html', import.meta.url), 'utf8'), store);
  try {
    await import('../web/mark.js?ui-mark-simple-tools'); const bridge = globalThis.editorBridge; await bridge.flush();
    assert.deepEqual(env.ids.get('tools').children.map(button => button.dataset.tool), ['block', 'tree', 'erase']);
    assert.deepEqual(store.marks.cols, [{ ...cols[0], t: 'block' }, { ...cols[1], t: 'block' }, cols[2]]);
    const d = bridge.diagnostics(), overlay = env.elements.filter(e => e.tagName === 'CANVAS').at(-1);
    const point = { clientX: d.panX + 45 * d.zoom, clientY: d.panY + 65 * d.zoom };
    const key = async value => { for (const fn of env.events.get('keydown') || []) await fn({ key: value, target: overlay, preventDefault() {} }); };
    await key('2'); await overlay.fire('pointerdown', point); await overlay.fire('pointerup', point); await bridge.flush(); assert.equal(store.marks.cols.find(m => m.c === 4).t, 'tree');
    await key('3'); await overlay.fire('pointerdown', point); await overlay.fire('pointerup', point); await bridge.flush(); assert.equal(store.marks.cols.some(m => m.c === 4), false);
    await env.ids.get('undo').click(); await bridge.flush(); assert.equal(store.marks.cols.find(m => m.c === 4).t, 'tree');
  } finally { env.restore(); }
});

test('标注页面恢复旧进度, 擦除可撤销, 清空也会自动保存', async () => {
  const frame = { id: 'a', src: 'frames/a.png', x: 100, y: 200, tile: 20, tileY: 30, phaseX: 3, phaseY: 7, on: true };
  const store = { names: ['a.png'], param: { version: 1, frames: [frame] }, marks: { version: 1, tile: 20, x0: 103, marker: 10, frames: [frame], cols: [{ c: 4, y: 267, t: 'block' }] } };
  const env = environment(await readFile(new URL('../web/mark.html', import.meta.url), 'utf8'), store);
  try {
    await import('../web/mark.js?ui-mark'); await globalThis.editorBridge.flush();
    const get = id => env.ids.get(id);
    assert.equal(globalThis.editorBridge.diagnostics().marks, 1);
    await get('clear').click(); await globalThis.editorBridge.flush(); assert.equal(store.marks.cols.length, 0);
    await get('undo').click(); await globalThis.editorBridge.flush(); assert.equal(store.marks.cols.length, 1);
    await get('redo').click(); await globalThis.editorBridge.flush(); assert.equal(store.marks.cols.length, 0);
    await get('undo').click(); await globalThis.editorBridge.flush();
    const marker = get('marker'); await marker.fire('focus'); marker.value = '25'; await marker.fire('change'); await globalThis.editorBridge.flush(); assert.equal(store.marks.marker, 25);
    await get('undo').click(); await globalThis.editorBridge.flush(); assert.equal(store.marks.marker, 10);
    const overlay = env.elements.filter(e => e.tagName === 'CANVAS').at(-1);
    await env.ids.get('tools').children.find(button => button.dataset.tool === 'erase').click();
    // 适应窗口后, 原标记的世界位置为 (183, 267), 屏幕位置按缩放换算.
    const zoom = Math.min((1000 - 64) / 1800, (700 - 64) / 1000);
    const panX = (1000 - (100 + 1900) * zoom) / 2, panY = (700 - (200 + 1200) * zoom) / 2;
    const point = { clientX: panX + 183 * zoom, clientY: panY + 267 * zoom };
    await overlay.fire('pointerdown', point); await overlay.fire('pointerup', point); await globalThis.editorBridge.flush();
    assert.equal(store.marks.cols.length, 0);
    await get('undo').click(); await globalThis.editorBridge.flush(); assert.equal(store.marks.cols.length, 1);
  } finally { env.restore(); }
});

test('最终观测可无截图导入导出, 不改变画布或搜索设置, 仅手动启动搜索', async () => {
  const store = { names: [], searcher_built: true, marks: { cols: [{ c: 0, y: 100, t: 'block' }], marker: 99 } };
  const originalMarks = structuredClone(store.marks);
  const env = environment(await readFile(new URL('../web/index.html', import.meta.url), 'utf8'), store);
  const createURL = URL.createObjectURL, downloads = [];
  URL.createObjectURL = blob => { downloads.push(blob); return createURL.call(URL, blob); };
  try {
    await import('../web/app.js?ui-final-observation');
    const get = id => env.ids.get(id), file = get('observation-file');
    const upload = async text => { file.files = [{ size: new Blob([text]).size, text: async () => text }]; await file.fire('change'); };
    const observation = { format: 'terraria-seed-searcher/observation', version: 1, heights: [0, -999, .125, 2.375, ...Array.from({ length: 20 }, (_, i) => i)], marker: 2 };
    assert.equal(get('export-observation').disabled, true); get('tol').value = '0.35';
    await upload('\uFEFF' + JSON.stringify(observation)); assert.equal(file.value, '');
    assert.deepEqual(store.observation, observation); assert.deepEqual(store.marks, originalMarks); assert.equal(store.param, undefined); assert.equal(get('tol').value, '0.35');
    assert.equal(env.post.filter(post => post.url === '/api/sweep').length, 0); assert.equal(get('start').disabled, false);
    const settle = () => new Promise(resolve => setImmediate(resolve));
    await get('tabs').fire('click', { target: { closest: () => get('tab-search') } }); await settle();
    assert.equal(get('tab-search').getAttribute('aria-selected'), 'true'); assert.equal(env.elements.filter(e => e.tagName === 'IFRAME').length, 0);
    await get('export-observation').click(); assert.equal(downloads.length, 1); assert.deepEqual(JSON.parse(await downloads[0].text()), observation);
    const count = env.post.length;
    for (const text of ['{', '{}', JSON.stringify({ ...observation, version: 999 })]) { await upload(text); assert.equal(env.post.length, count); assert.deepEqual(store.observation, observation); }
    globalThis.confirm = () => false; await upload(JSON.stringify({ ...observation, marker: 3 })); assert.equal(env.post.length, count); globalThis.confirm = () => true;
    store.fail = true; await upload(JSON.stringify({ ...observation, marker: 3 })); assert.deepEqual(store.observation, observation); store.fail = false;
    let readLarge = false; file.files = [{ size: 8 * 1024 * 1024 + 1, text: async () => { readLarge = true; return ''; } }]; await file.fire('change'); assert.equal(readLarge, false);
    await get('start').click(); const starts = env.post.filter(post => post.url === '/api/task/start'); assert.equal(starts.length, 1); assert.deepEqual(starts[0].data, { backend: 'cuda', parameters: { ...DEFAULT_SEARCH_PARAMETERS, tol: .35 } });
    store.running = true; await get('refresh').click(); assert.equal(get('import-observation').disabled, true);
  } finally { URL.createObjectURL = createURL; env.restore(); }
});

test('导入最终观测前等待旧编辑器保存, 后续进入搜索不会用旧画布覆盖导入数据', async () => {
  const frame = { id: 'a', src: 'frames/a.png', x: 0, y: 0, tile: 20, tileY: 20 };
  const store = { names: ['a.png'], param: { version: 1, frames: [frame] }, marks: { cols: [{ c: 0, y: 50, t: 'block' }] } };
  let pending = false, release, markCreated = 0;
  store.editorFactory = tab => { if (tab === 'mark') markCreated++; return { flush: async () => { if (pending) { pending = false; await new Promise(resolve => { release = resolve; }); store.observed = { source: 'manual', marker: 99 }; } } }; };
  const env = environment(await readFile(new URL('../web/index.html', import.meta.url), 'utf8'), store), settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    await import('../web/app.js?ui-observation-save-order'); const get = id => env.ids.get(id); await get('go-grid').click(); pending = true;
    const observation = { format: 'terraria-seed-searcher/observation', version: 1, heights: [0, 1, -999, 2], marker: 2 }, text = JSON.stringify(observation);
    get('observation-file').files = [{ size: text.length, text: async () => text }]; const importing = get('observation-file').fire('change'); await settle();
    assert.equal(env.post.length, 0); assert.equal(get('start').disabled, true); release(); await importing;
    assert.deepEqual(store.observation, observation); assert.equal(store.observed.source, 'import');
    await get('tabs').fire('click', { target: { closest: () => get('tab-search') } }); await settle();
    assert.equal(get('tab-search').getAttribute('aria-selected'), 'true'); assert.equal(markCreated, 0); assert.equal(store.observed.marker, 2);
  } finally { env.restore(); }
});

test('计算后端可手动选择主机 CPU 或 CUDA, CPU 请求主机接口且按编译状态启用', async () => {
  const store = { names: [], observed: { valid: 30, columns: 30, marker: 2, source: 'import' }, searcher_built: false, cpu_searcher_built: true, searcher_paths: { cuda: 'C:/fixture/sweep2.exe', cpu: 'C:/fixture/sweep-cpu.exe' } };
  const env = environment(await readFile(new URL('../web/index.html', import.meta.url), 'utf8'), store);
  try {
    await import('../web/app.js?ui-host-cpu-choice'); const get = id => env.ids.get(id), backend = get('search-backend');
    backend.value = 'cuda'; await backend.fire('change'); assert.equal(get('start').disabled, true);
    const reason = get('start-reason'); assert.equal(reason.hidden, false); assert.equal(reason.dataset.reasons, 'cuda-missing'); assert.ok(reason.children.some(line => line.textContent.includes(store.searcher_paths.cuda))); assert.equal(get('start').getAttribute('aria-describedby'), reason.id);
    store.searcher_built = true; await get('refresh').click(); assert.equal(get('start').disabled, false); assert.equal(reason.hidden, true); assert.equal(reason.children.length, 0);
    store.observed = null; await get('refresh').click(); assert.equal(get('start').disabled, true); assert.equal(reason.dataset.reasons, 'observation'); assert.equal(reason.hidden, false);
    store.observed = { valid: 30, columns: 30, marker: 2, source: 'import' }; store.running = true; await get('refresh').click(); assert.equal(reason.dataset.reasons, 'running');
    store.running = false; await get('refresh').click();
    backend.value = 'cpu'; await backend.fire('change'); assert.equal(get('start').disabled, false); assert.equal(reason.hidden, true);
    await get('start').click(); const starts = env.post.filter(row => row.url === '/api/task/start'); assert.equal(starts.length, 1); assert.equal(starts[0].data.backend, 'cpu'); assert.equal(starts[0].data.parameters.tol, .5);
    backend.value = 'webgpu'; await backend.fire('change'); assert.equal(get('start').disabled, true); assert.equal(reason.dataset.reasons, 'webgpu-unavailable'); assert.equal(reason.hidden, false);
    store.mlx_searcher_built = false; backend.value = 'mlx'; await backend.fire('change'); assert.equal(get('start').disabled, true); assert.equal(reason.dataset.reasons, 'mlx-missing'); assert.equal(reason.hidden, false);
    store.mlx_searcher_built = true; await get('refresh').click(); assert.equal(get('start').disabled, false); assert.equal(reason.hidden, true);
    assert.equal(env.elements.some(element => element.tagName === 'IFRAME'), false);
  } finally { env.restore(); }
});

test('恢复保存的任务使用任务参数, 不依赖当前观测或表单', async () => {
  const task = { id: 'saved-task', backend: 'cpu', parameters: { ...DEFAULT_SEARCH_PARAMETERS, range: [100, 200], tol: .25 }, next: 150, status: 'paused', can_resume: true, compatible: true, version: '1', progress: { status: 'stopped', scanned: 50, total: 100, elapsed: 10, candidates: 2 } };
  const store = { names: [], observed: null, cpu_searcher_built: true, tasks: [task] }, env = environment(await readFile(new URL('../web/index.html', import.meta.url), 'utf8'), store);
  try {
    globalThis.location.hash = '#search'; await import('../web/app.js?resume-task=' + Date.now()); await env.ids.get('refresh').click();
    const get = id => env.ids.get(id);
    get('search-task').value = task.id; await get('search-task').fire('change');
    assert.equal(get('start').disabled, true); assert.equal(get('resume-search').disabled, false);
    get('tol').value = '.9'; await get('resume-search').click();
    const resumes = env.post.filter(row => row.url === '/api/task/resume');
    assert.deepEqual(resumes.map(row => row.data), [{ id: task.id }]);
    assert.equal(Number(get('tol').value), .25); assert.equal(get('seed-from').value, '100');
    assert.equal(get('search-progress-bar').value, .5);
  } finally { env.restore(); }
});

test('主机进度和候选在运行中更新, 等长快照也会刷新', async () => {
  const store = { names: [], searcher_built: true, candidates: ['seed=1 score=1'], sweep: { backend: 'cuda', running: true, candidate_bytes: { cuda: 14 }, candidate_versions: { cuda: 'first' }, progress: { status: 'running', scanned: 40, total: 100, elapsed: 4, candidates: 1, rate: 10, eta: 6 } } };
  const env = environment(await readFile(new URL('../web/index.html', import.meta.url), 'utf8'), store), settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    await import('../web/app.js?ui-live-host-progress'); const get = id => env.ids.get(id);
    assert.equal(get('search-progress').hidden, false); assert.equal(get('search-progress').dataset.status, 'running'); assert.equal(get('search-progress-bar').value, .4);
    await get('go-candidates').click(); await settle(); assert.equal(get('candidates').children[0].children[1].textContent, store.candidates[0]);
    store.candidates = ['seed=2 score=1']; store.sweep.candidate_versions.cuda = 'second'; store.sweep.progress.scanned = 60;
    await get('refresh').click(); await settle(); assert.equal(get('candidates').children[0].children[1].textContent, store.candidates[0]); assert.equal(get('search-progress-bar').value, .6);
    store.sweep.running = false; store.sweep.progress.status = 'stopped'; store.sweep.progress.eta = null;
    await get('refresh').click(); assert.equal(get('search-progress').dataset.status, 'stopped'); assert.equal(get('search-progress-bar').value, .6);
    store.sweep.backend = 'cpu'; store.sweep.progress.status = 'completed'; store.sweep.progress.scanned = 100;
    get('search-backend').value = 'cpu'; await get('search-backend').fire('change'); await get('refresh').click(); assert.equal(get('search-progress-bar').value, 1); assert.equal(get('search-progress').dataset.status, 'completed');
    get('search-backend').value = 'webgpu'; await get('search-backend').fire('change'); assert.equal(get('search-progress').hidden, true);
  } finally { env.restore(); }
});

test('网格, 拼接和标注按顺序继承, 返回修改后不会被旧编辑器覆盖', async () => {
  const frame = { id: 'a', src: 'frames/a.png', x: 0, y: 0, tile: 20.86, tileY: 20.86, on: true };
  let fail = false, pendingGrid = false, pendingCalib = false, nextTile = 22;
  let loadedX = null, loadedTile = null, gridX = null, calibCreated = 0, markCreated = 0, gridCreated = 0;
  const store = { names: ['a.png'], param: { version: 1, frames: [frame] } };
  store.editorFactory = key => {
    if (key === 'grid') { gridCreated++; gridX = store.param.frames[0].x; }
    if (key === 'calib') { calibCreated++; loadedTile = store.param.frames[0].tile; }
    if (key === 'mark') { markCreated++; loadedX = store.param.frames[0].x; }
    return { flush: async () => {
      if (fail) throw new Error('offline');
      if (key === 'grid' && pendingGrid) { await Promise.resolve(); store.param.frames[0].tile = nextTile; store.param.frames[0].tileY = nextTile; pendingGrid = false; }
      if (key === 'calib' && pendingCalib) { await Promise.resolve(); store.param.frames[0].x = 250; pendingCalib = false; }
    } };
  };
  const env = environment(await readFile(new URL('../web/index.html', import.meta.url), 'utf8'), store);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    await import('../web/app.js?ui-tabs');
    const get = id => env.ids.get(id), clickTab = async tab => { await get('tabs').fire('click', { target: { closest: () => get('tab-' + tab) } }); await settle(); };
    await get('go-grid').click(); assert.equal(get('tab-grid').getAttribute('aria-selected'), 'true'); assert.equal(gridCreated, 1);
    pendingGrid = true; await clickTab('calib');
    assert.equal(loadedTile, 22); assert.equal(calibCreated, 1);
    pendingCalib = true; await clickTab('mark');
    assert.equal(get('tab-mark').getAttribute('aria-selected'), 'true'); assert.equal(loadedX, 250); assert.equal(markCreated, 1);
    await clickTab('calib'); assert.equal(calibCreated, 1);
    await clickTab('grid'); assert.equal(gridCreated, 2); assert.equal(gridX, 250);
    pendingGrid = true; nextTile = 24; await clickTab('calib');
    assert.equal(calibCreated, 2); assert.equal(loadedTile, 24); assert.equal(store.param.frames[0].x, 250);
    fail = true; await clickTab('mark');
    assert.equal(get('tab-calib').getAttribute('aria-selected'), 'true'); assert.equal(get('pane-calib').hidden, false); assert.equal(get('app-notice').hidden, false);
  } finally { env.restore(); }
});

test('删除任务需要确认, 删除后清空选中并刷新列表', async () => {
  const task = { id: 'saved-task', backend: 'cpu', parameters: { ...DEFAULT_SEARCH_PARAMETERS, range: [100, 200] }, next: 150, status: 'paused', can_resume: true, compatible: true, version: '1', progress: { status: 'stopped', scanned: 50, total: 100, elapsed: 10, candidates: 2 } };
  const store = { names: [], observed: null, cpu_searcher_built: true, tasks: [task] };
  const env = environment(await readFile(new URL('../web/index.html', import.meta.url), 'utf8'), store);
  try {
    globalThis.location.hash = '#search'; await import('../web/app.js?delete-task=' + Date.now()); await env.ids.get('refresh').click();
    const get = id => env.ids.get(id), deletes = () => env.post.filter(row => row.url === '/api/task/delete');
    assert.equal(get('delete-task').disabled, false);
    globalThis.confirm = () => false; await get('delete-task').click();
    assert.equal(deletes().length, 0);
    globalThis.confirm = () => true; await get('delete-task').click();
    assert.deepEqual(deletes().map(row => row.data), [{ id: task.id }]);
    assert.equal(store.tasks.length, 0);
    assert.equal(get('search-task').value, '');
    assert.equal(get('search-task').children.length, 1);
    assert.equal(get('delete-task').disabled, true);
  } finally { env.restore(); }
});
