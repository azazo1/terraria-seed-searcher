// 用内存 DOM 验证真实页面模块, 不读取或修改用户标注.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

function environment(html, store) {
  const elements = [], ids = new Map(), events = new Map(), raf = [];
  const ctx = new Proxy({}, { get: (_target, key) => key === 'measureText' ? () => ({ width: 20 }) : () => {}, set: () => true });
  class Element {
    constructor(tag) { this.tagName = tag.toUpperCase(); this.children = []; this.handlers = new Map(); this.attributes = {}; this.dataset = {}; this.style = { setProperty() {} }; this.className = ''; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.clientWidth = 1000; this.clientHeight = 700; this.parentNode = null; elements.push(this); }
    get classList() { return { contains: c => this.className.split(' ').includes(c), add: c => this.className = [...new Set([...this.className.split(' '), c])].join(' '), remove: c => this.className = this.className.split(' ').filter(x => x !== c).join(' '), toggle: (c, on) => { const has = this.className.split(' ').includes(c); this.classList[(on ?? !has) ? 'add' : 'remove'](c); } }; }
    get valueAsNumber() { return this.value === '' ? NaN : Number(this.value); }
    setAttribute(k, v) { this.attributes[k] = String(v); if (k.startsWith('data-')) this.dataset[k.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase())] = String(v); }
    getAttribute(k) { return this.attributes[k]; }
    removeAttribute(k) { delete this.attributes[k]; }
    append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); if (node.tagName === 'IFRAME') { const key = node.src.includes('calib') ? 'calib' : 'mark'; node.contentWindow = { editorBridge: store.editorFactory?.(key) || { flush: async () => {} } }; queueMicrotask(() => node.onload?.()); } } }
    prepend(...nodes) { for (const node of nodes) node.parentNode = this; this.children.unshift(...nodes); }
    replaceChildren(...nodes) { for (const node of this.children) node.parentNode = null; this.children = []; this.append(...nodes); }
    remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(n => n !== this); this.parentNode = null; }
    addEventListener(type, fn) { if (!this.handlers.has(type)) this.handlers.set(type, []); this.handlers.get(type).push(fn); }
    async fire(type, more = {}) { const e = { target: this, currentTarget: this, button: 0, pointerId: 1, clientX: 250, clientY: 250, preventDefault() {}, stopPropagation() {}, ...more }; if (this['on' + type]) await this['on' + type](e); for (const fn of this.handlers.get(type) || []) await fn(e); }
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
  class Image { constructor() { this.naturalWidth = 1800; this.naturalHeight = 1000; } set src(v) { this.url = v; queueMicrotask(() => this.onload?.()); } }
  const post = [];
  const fetch = async (url, options = {}) => {
    if (options.method === 'POST') {
      const data = JSON.parse(options.body); post.push({ url, data });
      if (store.fail) return { ok: false, status: 503, json: async () => ({ error: 'offline' }) };
      if (url === '/api/frames') store.param = structuredClone(data);
      if (url === '/api/marks') store.marks = structuredClone(data);
      return { ok: true, json: async () => ({ ok: true, observed: data.cols?.length ? { valid: data.cols.length, step_rate: 10 } : null }) };
    }
    const data = url === '/api/state' ? { frames: store.names, param: store.param, marks: { columns: store.marks?.cols?.length || 0 }, observed: null, searcher_built: false, sweep: { running: false, candidates: 0 } } : url === '/api/sweep/log' ? { log: '' } : url === '/api/candidates' ? { rows: [] } : url === '/frames' ? store.names : url === '/data/param.json' ? store.param : url === '/data/marks.json' ? store.marks : null;
    return { ok: !!data, status: data ? 200 : 404, json: async () => structuredClone(data || { error: 'HTTP 404' }) };
  };
  const names = ['document', 'Image', 'fetch', 'window', 'parent', 'location', 'ResizeObserver', 'devicePixelRatio', 'requestAnimationFrame', 'addEventListener', 'confirm', 'history', 'setInterval'];
  const before = new Map(names.map(k => [k, globalThis[k]]));
  Object.assign(globalThis, { document: doc, Image, fetch, window: globalThis, parent: globalThis, location: new URL('http://localhost/web/calib.html'), history: { replaceState(_state, _title, url) { globalThis.location.hash = url; } }, setInterval: () => 0, ResizeObserver: class { observe() {} }, devicePixelRatio: 1, requestAnimationFrame: fn => { raf.push(fn); return raf.length; }, addEventListener: doc.addEventListener, confirm: () => true });
  return { ids, elements, post, doc, raf, events, restore() { for (const [key, value] of before) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } delete globalThis.editorBridge; } };
}

test('对齐页面异步加载后生成图层和参数, 锁定阻止拖动, 自动保存继承数值', async () => {
  const store = { names: ['测试 50%.png'], param: null };
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
    const tile = get('tile'); env.doc.activeElement = tile; await tile.fire('focus'); tile.value = '21.25'; await tile.fire('input'); await tile.fire('change'); env.doc.activeElement = env.doc.body;
    await globalThis.editorBridge.flush(); assert.equal(store.param.frames[0].tile, 21.25); assert.equal(store.param.frames[0].tileY, 21.25);
    await get('undo').click(); await globalThis.editorBridge.flush(); assert.equal(store.param.frames[0].tile, 20.86);
    await get('redo').click(); await globalThis.editorBridge.flush(); assert.equal(store.param.frames[0].tile, 21.25);
    while (env.raf.length) env.raf.shift()();
    assert.ok(globalThis.editorBridge.diagnostics().paints >= 1);
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
    await env.ids.get('tools').children[4].click();
    // 适应窗口后, 原标记的世界位置为 (183, 267), 屏幕位置按缩放换算.
    const zoom = Math.min((1000 - 64) / 1800, (700 - 64) / 1000);
    const panX = (1000 - (100 + 1900) * zoom) / 2, panY = (700 - (200 + 1200) * zoom) / 2;
    const point = { clientX: panX + 183 * zoom, clientY: panY + 267 * zoom };
    await overlay.fire('pointerdown', point); await overlay.fire('pointerup', point); await globalThis.editorBridge.flush();
    assert.equal(store.marks.cols.length, 0);
    await get('undo').click(); await globalThis.editorBridge.flush(); assert.equal(store.marks.cols.length, 1);
  } finally { env.restore(); }
});

test('Tab 切换先保存当前编辑, 下游读取新参数, 失败时保留当前步骤', async () => {
  const frame = { id: 'a', src: 'frames/a.png', x: 0, y: 0, tile: 20.86, tileY: 20.86, on: true };
  let fail = false, pending = false, loadedX = null, calibCreated = 0, markCreated = 0;
  const store = { names: ['a.png'], param: { version: 1, frames: [frame] } };
  store.editorFactory = key => {
    if (key === 'calib') calibCreated++;
    if (key === 'mark') { markCreated++; loadedX = store.param.frames[0].x; }
    return { flush: async () => { if (fail) throw new Error('offline'); if (key === 'calib' && pending) { await Promise.resolve(); store.param.frames[0].x = 250; pending = false; } } };
  };
  const env = environment(await readFile(new URL('../web/index.html', import.meta.url), 'utf8'), store);
  const settle = () => new Promise(resolve => setImmediate(resolve));
  try {
    await import('../web/app.js?ui-tabs');
    const get = id => env.ids.get(id);
    await get('go-calib').click(); assert.equal(get('tab-calib').getAttribute('aria-selected'), 'true');
    assert.equal(calibCreated, 1); pending = true;
    await get('tabs').fire('click', { target: { closest: () => get('tab-mark') } }); await settle();
    assert.equal(get('tab-mark').getAttribute('aria-selected'), 'true'); assert.equal(loadedX, 250); assert.equal(markCreated, 1);
    await get('tabs').fire('click', { target: { closest: () => get('tab-calib') } }); await settle();
    assert.equal(calibCreated, 1);
    fail = true;
    await get('tabs').fire('click', { target: { closest: () => get('tab-mark') } }); await settle();
    assert.equal(get('tab-calib').getAttribute('aria-selected'), 'true'); assert.equal(get('pane-calib').hidden, false);
    assert.equal(get('app-notice').hidden, false);
  } finally { env.restore(); }
});
