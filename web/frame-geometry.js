/* 原始图片像素与拼接画布之间的统一变换. */
export const MIN_SCALE = .01, MAX_SCALE = 100;
export function scaleOf(frame) { return Number.isFinite(frame.scale) && frame.scale > 0 ? frame.scale : 1; }
export function frameSize(frame) {
  const scale = scaleOf(frame);
  return { width: (frame.img?.naturalWidth || 0) * scale, height: (frame.img?.naturalHeight || 0) * scale };
}
export function frameGrid(frame) {
  const scale = scaleOf(frame);
  return { width: frame.tile * scale, height: frame.tileY * scale, x: frame.x + frame.phaseX * scale, y: frame.y + frame.phaseY * scale };
}
export function imagePoint(frame, point) { const scale = scaleOf(frame); return { x: (point.x - frame.x) / scale, y: (point.y - frame.y) / scale }; }
export function canvasPoint(frame, point) { const scale = scaleOf(frame); return { x: frame.x + point.x * scale, y: frame.y + point.y * scale }; }
export function findFrame(frames, point) {
  return [...frames].reverse().find(frame => {
    if (frame.on === false || frame.failed || !frame.img?.naturalWidth) return false;
    const { width, height } = frameSize(frame);
    return point.x >= frame.x && point.x < frame.x + width && point.y >= frame.y && point.y < frame.y + height;
  });
}
export const GRID_GAP_LIMIT = .05;
export function gridGap(frames, limit = GRID_GAP_LIMIT) {
  const visible = frames.filter(frame => frame.on !== false && !frame.failed);
  if (visible.length < 2) return null;
  const grids = visible.map(frame => ({ id: frame.id, ...frameGrid(frame) }));
  const widthGap = Math.max(...grids.map(g => g.width)) / Math.min(...grids.map(g => g.width)) - 1;
  const heightGap = Math.max(...grids.map(g => g.height)) / Math.min(...grids.map(g => g.height)) - 1;
  return Math.max(widthGap, heightGap) > limit + 1e-9 ? { limit, widthGap, heightGap, grids } : null;
}
