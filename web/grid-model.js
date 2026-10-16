/* 双线标定的像素与格数换算. */
export const modulo = (value, step) => ((value % step) + step) % step;
export function guideFor(frame, axis) {
  const spacing = axis === 'x' ? frame.tile : frame.tileY;
  const phase = axis === 'x' ? frame.phaseX : frame.phaseY;
  const length = axis === 'x' ? frame.img?.naturalWidth : frame.img?.naturalHeight;
  const stored = frame.gridGuides?.[axis];
  if (stored) return { ...stored, moving: stored.fixed + Math.sign(stored.moving - stored.fixed || 1) * stored.cells * spacing };
  const fixed = phase + Math.max(0, Math.round((length || spacing * 100) * .08 / spacing)) * spacing;
  const cells = Math.max(1, Math.min(100000, Math.round((length || spacing * 100) * .7 / spacing)));
  return { fixed, moving: fixed + cells * spacing, cells };
}
export function nearestGridLine(frame, axis, coordinate) {
  const spacing = axis === 'x' ? frame.tile : frame.tileY;
  const phase = axis === 'x' ? frame.phaseX : frame.phaseY;
  const index = Math.round((coordinate - phase) / spacing);
  return { index, coordinate: phase + index * spacing };
}
export function selectedGridPair(frame, axis, fixed, moving) {
  const first = nearestGridLine(frame, axis, fixed), second = nearestGridLine(frame, axis, moving);
  if (first.index === second.index) throw new Error('请选择另一条网格线.');
  return { fixed: first.coordinate, moving: second.coordinate, cells: Math.abs(second.index - first.index) };
}
export function moveGridEndpoint(guide, endpoint, coordinate) {
  const next = { ...guide, [endpoint]: coordinate };
  if (Math.sign(next.moving - next.fixed) !== Math.sign(guide.moving - guide.fixed)) throw new Error('两条线不能重合或互相跨越.');
  measureGrid(next.fixed, next.moving, next.cells);
  return next;
}
export function measureGrid(fixed, moving, cells) {
  if (!Number.isFinite(fixed) || !Number.isFinite(moving) || !Number.isSafeInteger(cells) || cells < 1 || cells > 100000) throw new Error('两线之间的格数必须是 1-100000 的整数.');
  const tile = Math.abs(moving - fixed) / cells;
  if (tile < 1 || tile > 512) throw new Error('每格应在 1-512 px 之间. 请检查两线位置和格数.');
  return { tile, phase: modulo(fixed, tile), guide: { fixed, moving, cells } };
}
export function applyMeasurement(frame, axis, guide, square = false) {
  const result = measureGrid(guide.fixed, guide.moving, guide.cells);
  const tileKey = axis === 'x' ? 'tile' : 'tileY', phaseKey = axis === 'x' ? 'phaseX' : 'phaseY';
  const guides = { ...frame.gridGuides, [axis]: result.guide };
  const patch = { [tileKey]: result.tile, [phaseKey]: result.phase, gridGuides: guides, gridCalibrated: true };
  if (square) {
    const other = axis === 'x' ? 'y' : 'x', otherGuide = guideFor(frame, other);
    guides[other] = { ...otherGuide, moving: otherGuide.fixed + Math.sign(otherGuide.moving - otherGuide.fixed || 1) * otherGuide.cells * result.tile };
    patch[other === 'x' ? 'tile' : 'tileY'] = result.tile;
    patch[other === 'x' ? 'phaseX' : 'phaseY'] = modulo(otherGuide.fixed, result.tile);
  }
  return patch;
}
