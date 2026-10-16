/* 对齐变化后把已有观测迁移到新的列网格. */
import { canvasPoint, findFrame, frameGrid, frameSize, imagePoint, scaleOf } from './frame-geometry.js';
export const MARKS_VERSION = 2;
export function inheritObservation(stored, frames) {
  if (stored?.version > MARKS_VERSION) throw new Error('标注版本较新, 请更新工作台后再打开.');
  const left = [...frames].sort((a, b) => a.x - b.x)[0];
  const tile = left ? frameGrid(left).width : 20.86, anchor = left ? frameGrid(left).x : 0;
  if (!stored) return { tile, x0: anchor, marker: 141, cols: [], migrated: false, collisions: 0 };
  const oldTile = stored.tile || tile;
  const oldLeft = [...(stored.frames || [])].sort((a, b) => a.x - b.x)[0];
  const oldOrigin = Number.isFinite(stored.x0) ? stored.x0 : (oldLeft?.x || 0);
  const original = (stored.cols || []).filter(m => Number.isSafeInteger(m.c) && m.c >= 0 && Number.isFinite(m.y));
  const convertedShapes = original.filter(m => m.t === 'slopeL' || m.t === 'slopeR').length;
  const valid = original.map(m => m.t === 'slopeL' || m.t === 'slopeR' ? { ...m, t: 'block' } : m);
  const sameFrames = (stored.frames || []).length === frames.length && (stored.frames || []).every(old => {
    const f = frames.find(f => f.id === old.id);
    return f && scaleOf(f) === scaleOf(old) && ['x', 'y', 'tile', 'tileY', 'phaseX', 'phaseY'].every(k => f[k] === old[k]);
  });
  if (sameFrames && oldTile === tile) return { tile, x0: oldOrigin, marker: stored.marker ?? 141, cols: valid, migrated: convertedShapes > 0, convertedShapes, collisions: 0 };
  // 新标注保存原图像素锚点. 旧标注只在缩放发生变化时尝试从旧布局恢复锚点.
  const oldFrames = (stored.frames || []).map(old => ({ ...old, img: frames.find(f => f.id === old.id)?.img }));
  const scaleChanged = oldFrames.some(old => { const f = frames.find(f => f.id === old.id); return f && scaleOf(f) !== scaleOf(old); });
  const mapped = valid.map(m => {
    let source = frames.find(f => f.id === m.frameId), local;
    if (source && Number.isFinite(m.imageX) && Number.isFinite(m.imageY)) local = { x: m.imageX, y: m.imageY };
    else if (scaleChanged) {
      const point = { x: oldOrigin + (m.c + .5) * oldTile, y: m.y };
      const old = findFrame(oldFrames, { ...point, y: point.y + .001 });
      if (old) { source = frames.find(f => f.id === old.id); local = imagePoint(old, point); }
    }
    if (source && local) {
      const point = canvasPoint(source, local);
      return { coordinate: point.x - tile / 2, mark: { ...m, y: Math.round(point.y * 1000) / 1000, frameId: source.id, imageX: local.x, imageY: local.y } };
    }
    return { coordinate: oldOrigin + m.c * oldTile, mark: m };
  });
  let markerX = oldOrigin + (stored.marker ?? 141) * oldTile;
  if (scaleChanged) {
    const center = markerX + oldTile / 2;
    const old = [...oldFrames].reverse().find(f => center >= f.x && center < f.x + frameSize(f).width);
    const source = old && frames.find(f => f.id === old.id);
    if (source) markerX = source.x + (center - old.x) / scaleOf(old) * scaleOf(source) - tile / 2;
  }
  const minX = mapped.length ? Math.min(...mapped.map(m => m.coordinate), markerX) : anchor;
  const x0 = anchor + Math.min(0, Math.floor((minX - anchor) / tile)) * tile;
  const cols = new Map();
  for (const { coordinate, mark } of mapped) {
    const c = Math.max(0, Math.round((coordinate - x0) / tile));
    cols.set(c, { ...mark, c });
  }
  const marker = Math.max(0, Math.round((markerX - x0) / tile));
  return { tile, x0, marker, cols: [...cols.values()], migrated: true, convertedShapes, collisions: valid.length - cols.size };
}
export function snapPoint(point, list, origin, tile) {
  const f = findFrame(list, point);
  if (!f) return null;
  const { width, height, x: gx, y: gy } = frameGrid(f);
  const left = gx + Math.floor((point.x - gx) / width) * width;
  const top = gy + Math.floor((point.y - gy) / height) * height;
  const x = left + width / 2, y = top + height / 2;
  const col = Math.floor((x - origin) / tile); if (col < 0) return null;
  // 显示使用方块中心, 保存的地表高度仍使用上边缘.
  return { col, x, y, surfaceY: top, left, top, width, height, f };
}
