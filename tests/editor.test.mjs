// 覆盖自动保存并发, 坐标换算与画布重绘边界.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Autosave, History, Viewport, boundsOf, drawFrame, gridStart, imageURL, normalizeFrame } from '../web/editor-core.js';
import { inheritObservation, snapPoint } from '../web/observation.js';
import { canvasPoint, findFrame, frameGrid, frameSize, gridGap, imagePoint } from '../web/frame-geometry.js';
import { applyMeasurement, guideFor, measureGrid, nearestGridLine, selectedGridPair } from '../web/grid-model.js';
import { migrateParam, PARAM_VERSION } from '../web/frame-schema.js';
import { DEFAULT_SEARCH_PARAMETERS, normalizeSearchParameters } from '../web/search-parameters.js';
import { prepareSearch, scoreProfile, terrainProfile } from '../web/gpu/terrain-reference.js';
import { SearchSession } from '../web/gpu/search-session.js';

test('浏览器搜索限制中世界和观测长度, 正确匹配合成地形且忽略缺失列', () => {
  const profile = terrainProfile(42, 3400), obs = { heights: Array.from(profile.slice(3100, 3196), (v, i) => i % 7 === 0 ? -999 : (v - profile[3100]) / 8 + 30), marker: 100 };
  const settings = { ...DEFAULT_SEARCH_PARAMETERS, range: [40, 45], spawn_lo: 3198, spawn_hi: 3202, scales: '.97,1.00,1.03' };
  const match = scoreProfile(profile, obs, settings); assert.equal(match.quantized, 10000000); assert.equal(match.spawn, 3200); assert.equal(match.scale, 1);
  for (const observation of [{ ...obs, heights: [] }, { ...obs, heights: Array(701).fill(0) }, { ...obs, heights: Array(30).fill(-999) }, { ...obs, heights: [...obs.heights, NaN] }, { ...obs, marker: -1 }]) assert.throws(() => prepareSearch(observation, settings));
  assert.throws(() => prepareSearch(obs, { ...settings, cols: 8400 }));
});

test('浏览器搜索会话保留候选, 报告进度并在失败或停止后释放设备', async () => {
  const obs = { heights: Array(30).fill(0), marker: 10 }, settings = { ...DEFAULT_SEARCH_PARAMETERS, range: [40, 45] }; let destroyed = 0, changed = 0;
  const fake = { cancelled: false, adapterInfo: 'test GPU', initialize: async () => {}, selfTest: async () => ({ seeds: 12, columns: 76800 }), run: async (_obs, _parameters, progress) => { progress({ next: 45, scanned: 5, total: 5, elapsed: .1, candidates: [{ seed: 44, score: .6, spawn: 3200, scale: 1 }, { seed: 42, score: 1, spawn: 3200, scale: 1 }] }); return { next: 45, scanned: 5, cancelled: false }; }, stop() { this.cancelled = true; }, destroy() { destroyed++; } };
  const session = new SearchSession(() => changed++, () => fake); await session.start(obs, settings);
  assert.equal(session.running, false); assert.equal(destroyed, 1); assert.ok(changed > 2); assert.equal(session.rows[0].seed, 42); assert.equal(session.summary.next, 45); assert.equal(session.lines().length, 2);
  assert.equal(session.progress.status, 'completed'); assert.equal(session.progress.scanned, 5); assert.equal(session.progress.total, 5); assert.equal(session.progress.candidates, 2); assert.ok(Number.isFinite(session.progress.elapsed) && session.progress.elapsed >= 0);
  fake.selfTest = async () => { throw new Error('probe failed'); }; await assert.rejects(session.start(obs, settings), /probe failed/); assert.equal(session.running, false); assert.equal(destroyed, 2); assert.equal(session.rows.length, 0); assert.equal(session.progress.status, 'failed'); assert.equal(session.progress.scanned, 0);
  fake.selfTest = async () => { session.stop(); return null; }; await session.start(obs, settings); assert.equal(destroyed, 3); assert.equal(session.running, false); assert.equal(session.progress.status, 'stopped');
});

test('粗筛设置保留数值校验, 拒绝错误类型和范围', () => {
  const parameters = { ...DEFAULT_SEARCH_PARAMETERS, tol: .3, offer: .7, range: [100, 200], spawn_lo: 3100, spawn_hi: 3250, cols: 4000, scales: '0.97,1.00,1.03', batch: 12345, device: 2 };
  assert.deepEqual(normalizeSearchParameters(parameters), parameters);
  assert.deepEqual(normalizeSearchParameters(DEFAULT_SEARCH_PARAMETERS), DEFAULT_SEARCH_PARAMETERS);
  for (const patch of [{ tol: NaN }, { offer: 1.1 }, { range: [5, 5] }, { range: [-1, 5] }, { spawn_lo: 3300 }, { cols: 3200 }, { batch: 1.5 }, { device: '2' }, { scales: '1,,2' }, { scales: '1;alert(1)' }, { scales: '1,1,1,1,1,1,1,1,1' }, { extra: true }]) assert.throws(() => normalizeSearchParameters({ ...parameters, ...patch }));
});

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

test('吸附鼠标所在方块的中心, 使用当前图片格宽格高, 地表保留上边缘', () => {
  const p = snapPoint({ x: 144, y: 263 }, [frame], 103, 20);
  assert.equal(p.col, 2); assert.equal(p.x, 153); assert.equal(p.y, 252); assert.equal(p.surfaceY, 237);
  assert.deepEqual([p.left, p.top, p.width, p.height], [143, 237, 20, 30]);
  const otherCorner = snapPoint({ x: 162.99, y: 237.01 }, [frame], 103, 20);
  assert.equal(otherCorner.col, p.col); assert.equal(otherCorner.x, p.x); assert.equal(otherCorner.y, p.y);
  const next = snapPoint({ x: 163, y: 267 }, [frame], 103, 20);
  assert.equal(next.col, 3); assert.equal(next.x, 173); assert.equal(next.y, 282); assert.equal(next.surfaceY, 267);
  const small = snapPoint({ x: 144, y: 263 }, [{ ...frame, tile: 10, tileY: 10 }], 103, 20);
  assert.equal(small.width, 10); assert.equal(small.height, 10); assert.equal(small.x, 148); assert.equal(small.y, 262);
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

test('单图缩放统一图片范围, 网格相位, 命中和像素转换', () => {
  const scaled = { ...frame, scale: 2 };
  assert.deepEqual(frameSize(scaled), { width: 2000, height: 1200 });
  assert.deepEqual(frameGrid(scaled), { x: 106, y: 214, width: 40, height: 60 });
  assert.deepEqual(boundsOf([scaled]), { x: 100, y: 200, right: 2100, bottom: 1400 });
  assert.equal(findFrame([scaled], { x: 1800, y: 1200 }), scaled);
  assert.equal(findFrame([scaled], { x: 2100, y: 1200 }), undefined);
  const pixel = { x: 37.5, y: 49 }; assert.deepEqual(imagePoint(scaled, canvasPoint(scaled, pixel)), pixel);
  const snapped = snapPoint({ x: 187, y: 275 }, [scaled], 106, 40);
  assert.deepEqual([snapped.col, snapped.x, snapped.y, snapped.surfaceY, snapped.width, snapped.height], [2, 206, 304, 274, 40, 60]);
  const calls = [], ctx = new Proxy({}, { get: (_target, key) => key === 'measureText' ? () => ({ width: 20 }) : (...args) => calls.push([key, ...args]), set: () => true });
  drawFrame(ctx, { bounds: { x: 200, y: 300, right: 400, bottom: 500 }, zoom: 1 }, scaled, { grid: 0 });
  assert.deepEqual(calls.find(c => c[0] === 'drawImage').slice(2), [50, 50, 100, 100, 200, 300, 200, 200]);
  assert.equal(migrateParam({ version: 2, frames: [frame] }).frames[0].scale, 1);
  assert.equal(migrateParam({ version: PARAM_VERSION, frames: [scaled] }).frames[0].scale, 2);
});

test('仅在缩放后的格宽或格高差距超过阈值时警示, 隐藏和失败图片不参与', () => {
  const a = { ...frame, tile: 20, tileY: 30 }, b = { ...frame, id: 'b', tile: 10, tileY: 15, scale: 2 };
  assert.equal(gridGap([a]), null); assert.equal(gridGap([a, b]), null);
  assert.equal(gridGap([a, { ...b, scale: 2.1 }]), null);
  assert.ok(gridGap([a, { ...b, scale: 2.102 }]));
  const heightOnly = gridGap([a, { ...b, tileY: 16 }]); assert.equal(heightOnly.widthGap, 0); assert.ok(heightOnly.heightGap > .05);
  assert.equal(gridGap([a, { ...b, scale: 4, on: false }]), null);
  assert.equal(gridGap([a, { ...b, scale: 4, failed: true }]), null);
  assert.ok(gridGap([{ ...a, tile: 20 }, { ...a, tile: 20.8 }, { ...a, tile: 21.6 }]));
});

test('缩放后标注与出生点跟随原图片像素, 原有高度不会留在旧尺寸上', () => {
  const stored = { version: 1, tile: 20, x0: 103, marker: 10, frames: [frame], cols: [{ c: 4, y: 267, t: 'block' }] };
  const smaller = { ...frame, scale: .5 };
  const inherited = inheritObservation(stored, [smaller]);
  assert.equal(inherited.tile, 10); assert.equal(inherited.x0, 101.5); assert.equal(inherited.marker, 10);
  assert.equal(inherited.cols[0].c, 4); assert.equal(inherited.cols[0].y, 233.5);
  assert.equal(inherited.cols[0].frameId, 'a'); assert.equal(inherited.cols[0].imageX, 93); assert.equal(inherited.cols[0].imageY, 67);
  const saved = { ...inherited, version: 2, frames: [smaller] };
  const moved = inheritObservation(saved, [{ ...smaller, x: 500, y: 700, scale: 1 }]);
  assert.equal(moved.cols[0].c, 4); assert.equal(moved.cols[0].y, 767);
  assert.equal(moved.cols[0].imageX, 93); assert.equal(moved.cols[0].imageY, 67);
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
