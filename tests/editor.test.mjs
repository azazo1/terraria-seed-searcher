// 覆盖自动保存并发, 坐标换算与画布重绘边界.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Autosave, History, Viewport, boundsOf, drawFrame, gridStart, imageURL, normalizeFrame } from '../web/editor-core.js';
import { inheritObservation, snapPoint } from '../web/observation.js';
import { applyMeasurement, guideFor, measureGrid, nearestGridLine, selectedGridPair } from '../web/grid-model.js';
import { migrateParam, PARAM_VERSION } from '../web/frame-schema.js';

test('撤销与重做保留独立快照, 新操作清除重做', () => {
  const h = new History(2), first = { cols: [{ y: 1 }] };
  h.push(first); first.cols[0].y = 9;
  assert.equal(h.undo({ cols: [{ y: 2 }] }).cols[0].y, 1);
  assert.equal(h.redo({ cols: [{ y: 1 }] }).cols[0].y, 2);
  h.undo({ cols: [] }); h.push({ cols: [] }); assert.equal(h.future.length, 0);
  h.push(1); h.push(2); h.push(3); assert.equal(h.past.length, 2);
});

test('并发 flush 共用请求, 保存途中新增的修改也会落盘', async () => {
  let current = 1, saved = 0, calls = 0, release;
  const a = new Autosave(async () => {
    const snapshot = current; calls++;
    if (calls === 1) await new Promise(resolve => { release = resolve; });
    saved = snapshot; return true;
  }, () => current !== saved);
  const one = a.flush(), two = a.flush();
  assert.equal(one, two); assert.equal(calls, 1);
  current = 2; release(); await Promise.all([one, two]);
  assert.equal(saved, 2); assert.equal(calls, 2);
  await a.flush(); assert.equal(calls, 2);
});

test('保存失败会阻止 flush 完成, 数据保留且可以重试', async () => {
  let fail = true, saved = false;
  const a = new Autosave(async () => { if (fail) return false; saved = true; return true; }, () => !saved);
  await assert.rejects(a.flush()); assert.equal(saved, false);
  fail = false; await a.flush(); assert.equal(saved, true);
});

test('保存 debounce 合并连续修改', async () => {
  let dirty = true, calls = 0;
  const a = new Autosave(async () => { calls++; dirty = false; return true; }, () => dirty, 5);
  a.schedule(); a.schedule(); a.schedule();
  await new Promise(resolve => setTimeout(resolve, 15)); assert.equal(calls, 1);
});

test('图片路径支持空格, 中文和百分号, 参数有限且保留锁定', () => {
  assert.equal(imageURL('/frames/测试 50%.png'), '/frames/%E6%B5%8B%E8%AF%95%2050%25.png');
  const f = normalizeFrame({ src: '//frames/a.png', x: NaN, y: Infinity, tile: -1, locked: true }, 2);
  assert.equal(f.src, 'frames/a.png'); assert.equal(f.x, 2400); assert.equal(f.y, 0); assert.equal(f.tile, 1); assert.equal(f.locked, true);
  assert.equal(gridStart(-31, 3, 20), -17);
});
test('选线吸附已有网格, 反向选线也能自动取得间隔格数', () => {
  const f = { tile: 20, tileY: 30, phaseX: 3, phaseY: 7 };
  assert.deepEqual(nearestGridLine(f, 'x', 104), { index: 5, coordinate: 103 });
  assert.deepEqual(selectedGridPair(f, 'x', 104, 1102), { fixed: 103, moving: 1103, cells: 50 });
  assert.deepEqual(selectedGridPair(f, 'y', 608, 98), { fixed: 607, moving: 97, cells: 17 });
  assert.throws(() => selectedGridPair(f, 'x', 102, 104));
});

test('长距离双线标定保留固定端, 正向和反向测量得到相同格距', () => {
  for (const moving of [20100.25, -19899.75]) {
    const result = measureGrid(100.25, moving, 1000);
    assert.equal(result.tile, 20); assert.equal(result.phase, .25); assert.equal(result.guide.fixed, 100.25);
    assert.equal((result.guide.fixed - result.phase) / result.tile, 5);
  }
  assert.throws(() => measureGrid(10, 10, 10));
  assert.throws(() => measureGrid(10, 1000, 0));
  assert.throws(() => measureGrid(10, 1000, 1.5));
});

test('同步正方格时另一方向的基准也保持固定, 不改变拼接位置', () => {
  const f = { tile: 20, tileY: 30, phaseX: 0, phaseY: 7, x: 900, y: 80, gridGuides: { y: { fixed: 37, moving: 337, cells: 10 } } };
  const patch = applyMeasurement(f, 'x', { fixed: 100, moving: 1200, cells: 50 }, true);
  assert.equal(patch.tile, 22); assert.equal(patch.tileY, 22); assert.equal(patch.phaseX, 12);
  assert.equal(patch.gridGuides.y.fixed, 37); assert.equal(patch.phaseY, 15);
  assert.equal((37 - patch.phaseY) / patch.tileY, 1);
  assert.equal(f.x, 900); assert.equal(f.y, 80); assert.equal(patch.x, undefined);
  assert.deepEqual(guideFor({ ...f, ...patch }, 'x'), { fixed: 100, moving: 1200, cells: 50 });
});

test('旧参数迁移保留网格与拼接, 新版保存后保留双线标定状态', () => {
  const legacy = { version: 1, frames: [{ src: 'frames/a.png', x: 500, y: -9, tile: 20.86, tileY: 19.5, phaseX: 3.2, phaseY: 7, locked: true }] };
  const migrated = migrateParam(legacy), f = migrated.frames[0];
  assert.equal(migrated.version, PARAM_VERSION); assert.equal(f.x, 500); assert.equal(f.tileY, 19.5); assert.equal(f.phaseX, 3.2); assert.equal(f.locked, true); assert.equal(f.gridCalibrated, true);
  f.gridGuides.x = { fixed: 103.2, moving: 1146.2, cells: 50 };
  assert.deepEqual(migrateParam(migrated).frames[0].gridGuides, f.gridGuides);
  assert.equal(normalizeFrame({ src: 'frames/new.png' }, 0).gridCalibrated, false);
  assert.throws(() => migrateParam({ version: PARAM_VERSION + 1, frames: [] }));
});

const image = { naturalWidth: 1000, naturalHeight: 600 };
const frame = { id: 'a', src: 'frames/a.png', x: 100, y: 200, tile: 20, tileY: 30, phaseX: 3, phaseY: 7, on: true, img: image };

test('垂直吸附包含图片位移与相位, 使用格高', () => {
  const p = snapPoint({ x: 144, y: 263 }, [frame], 103, 20);
  assert.equal(p.col, 2); assert.equal(p.x, 143); assert.equal(p.y, 267);
  assert.equal(snapPoint({ x: 10, y: 10 }, [frame], 103, 20), null);
  assert.equal(snapPoint({ x: 144, y: 263 }, [{ ...frame, on: false }], 103, 20), null);
});

test('原参数恢复标记不改变坐标, 新格宽继承时换算列号', () => {
  const stored = { tile: 20, x0: 103, marker: 10, frames: [frame], cols: [{ c: 4, y: 267, t: 'block' }] };
  const same = inheritObservation(stored, [frame]); assert.equal(same.migrated, false); assert.deepEqual(same.cols, stored.cols);
  const next = inheritObservation(stored, [{ ...frame, tile: 10 }]);
  assert.equal(next.tile, 10); assert.equal(next.cols[0].c, 8); assert.equal(next.marker, 20); assert.equal(next.cols[0].y, 267); assert.equal(next.migrated, true);
});

test('向右移动原点后, 左侧已有标记仍保留非负列号', () => {
  const stored = { tile: 20, x0: 103, marker: 10, frames: [frame], cols: [{ c: 0, y: 267, t: 'tree' }] };
  const next = inheritObservation(stored, [{ ...frame, x: 150 }]);
  assert.equal(next.cols.length, 1); assert.ok(next.cols[0].c >= 0); assert.ok(next.x0 <= 103);
  assert.equal(next.cols[0].t, 'tree');
});

test('仅绘制可见图片区域, 视口外图片不触发 drawImage', () => {
  const calls = [], ctx = new Proxy({}, { get: (_target, key) => key === 'measureText' ? () => ({ width: 20 }) : (...args) => calls.push([key, ...args]), set: () => true });
  const view = { bounds: { x: 200, y: 250, right: 300, bottom: 350 }, zoom: 2 };
  drawFrame(ctx, view, frame, { grid: .5 });
  const call = calls.find(c => c[0] === 'drawImage'); assert.deepEqual(call.slice(2), [100, 50, 100, 100, 200, 250, 100, 100]);
  const before = calls.length; drawFrame(ctx, view, { ...frame, x: 4000 }); assert.equal(calls.length, before);
  assert.deepEqual(boundsOf([frame, { ...frame, x: 5000, on: false }]), { x: 100, y: 200, right: 1100, bottom: 800 });
});

test('缩小时仍绘制全部方块边界, 与原比例保持相同网格坐标', () => {
  const linesAt = zoom => {
    const lines = [];
    const ctx = new Proxy({}, { get: (_target, key) => key === 'measureText' ? () => ({ width: 20 }) : key === 'moveTo' ? (x, y) => lines.push([x, y]) : () => {}, set: () => true });
    drawFrame(ctx, { bounds: { x: 200, y: 250, right: 300, bottom: 350 }, zoom }, frame, { grid: .5 });
    return lines;
  };
  const expected = [[203, 250], [223, 250], [243, 250], [263, 250], [283, 250], [200, 267], [200, 297], [200, 327]];
  assert.deepEqual(linesAt(1), expected);
  assert.deepEqual(linesAt(.1), expected);
  assert.deepEqual(linesAt(.03), expected);
});

test('画布每帧仅重绘一次, hover 只更新覆盖层, 缩放保持鼠标锚点', () => {
  const callbacks = [], elements = [], globals = ['document', 'requestAnimationFrame', 'ResizeObserver', 'devicePixelRatio'];
  const previous = new Map(globals.map(k => [k, globalThis[k]]));
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  globalThis.document = { createElement: () => { const el = { width: 0, height: 0, setAttribute() {}, getContext: () => ctx, addEventListener() {} }; elements.push(el); return el; }, getElementById: () => null };
  globalThis.requestAnimationFrame = fn => { callbacks.push(fn); return callbacks.length; };
  globalThis.ResizeObserver = class { observe() {} }; globalThis.devicePixelRatio = 2;
  try {
    let base = 0, overlay = 0;
    const host = { clientWidth: 800, clientHeight: 500, prepend() {} };
    const v = new Viewport(host, () => base++, () => overlay++);
    v.invalidate(); v.invalidate(); assert.equal(callbacks.length, 1); callbacks.shift()(); assert.equal(base, 1);
    v.invalidate(false); v.invalidate(false); callbacks.shift()(); assert.equal(base, 1); assert.equal(overlay, 2);
    const anchor = { x: 400, y: 150 }, point = v.world(anchor); v.scaleAt(2, anchor); assert.deepEqual(v.world(anchor), point);
    assert.equal(elements[0].width, 1600); assert.equal(elements[0].height, 1000);
  } finally { for (const [key, value] of previous) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } }
});
