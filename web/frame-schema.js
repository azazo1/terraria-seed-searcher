/* 标定配置版本与旧参数迁移. */
export const PARAM_VERSION = 2;
const finite = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export function normalizeFrame(f, i) {
  const tile = clamp(finite(f.tile, 20.86), 1, 512);
  const guides = {};
  for (const axis of ['x', 'y']) {
    const guide = f.gridGuides?.[axis];
    if (guide && Number.isFinite(guide.fixed) && Number.isFinite(guide.moving) && Number.isSafeInteger(guide.cells) && guide.cells > 0 && guide.cells <= 100000) guides[axis] = { fixed: guide.fixed, moving: guide.moving, cells: guide.cells };
  }
  return { id: f.id || `frame${i + 1}`, src: f.src.replace(/^\/+/, ''),
    tile, tileY: clamp(finite(f.tileY, tile), 1, 512),
    phaseX: finite(f.phaseX, 0), phaseY: finite(f.phaseY, 0),
    x: finite(f.x, i * 1200), y: finite(f.y, 0), on: f.on !== false, locked: !!f.locked,
    gridCalibrated: !!f.gridCalibrated, gridGuides: guides };
}
export function migrateParam(raw) {
  if (!raw || !Array.isArray(raw.frames)) throw new Error('标定参数缺少图片列表.');
  const version = raw.version || 1;
  if (version > PARAM_VERSION) throw new Error('标定参数版本较新, 请更新工作台后再打开.');
  return { version: PARAM_VERSION, frames: raw.frames.map((f, i) => normalizeFrame({ ...f, gridCalibrated: f.gridCalibrated ?? version < 2 }, i)) };
}
