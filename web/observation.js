/* 对齐变化后把已有观测迁移到新的列网格. */
export function inheritObservation(stored, frames) {
  const left = [...frames].sort((a, b) => a.x - b.x)[0];
  const tile = left?.tile || 20.86, anchor = left ? left.x + left.phaseX : 0;
  if (!stored) return { tile, x0: anchor, marker: 141, cols: [], migrated: false, collisions: 0 };
  const oldTile = stored.tile || tile;
  const oldLeft = [...(stored.frames || [])].sort((a, b) => a.x - b.x)[0];
  const oldOrigin = Number.isFinite(stored.x0) ? stored.x0 : (oldLeft?.x || 0);
  const valid = (stored.cols || []).filter(m => Number.isSafeInteger(m.c) && m.c >= 0 && Number.isFinite(m.y));
  const sameFrames = (stored.frames || []).length === frames.length && (stored.frames || []).every(old => {
    const f = frames.find(f => f.id === old.id);
    return f && ['x', 'y', 'tile', 'tileY', 'phaseX', 'phaseY'].every(k => f[k] === old[k]);
  });
  if (sameFrames && oldTile === tile) return { tile, x0: oldOrigin, marker: stored.marker ?? 141, cols: valid, migrated: false, collisions: 0 };
  const minX = valid.length ? Math.min(...valid.map(m => oldOrigin + m.c * oldTile), oldOrigin + (stored.marker ?? 141) * oldTile) : anchor;
  const x0 = anchor + Math.min(0, Math.floor((minX - anchor) / tile)) * tile;
  const cols = new Map();
  for (const m of valid) {
    const c = Math.max(0, Math.round((oldOrigin + m.c * oldTile - x0) / tile));
    cols.set(c, { ...m, c });
  }
  const marker = Math.max(0, Math.round((oldOrigin + (stored.marker ?? 141) * oldTile - x0) / tile));
  return { tile, x0, marker, cols: [...cols.values()], migrated: true, collisions: valid.length - cols.size };
}
export function snapPoint(point, list, origin, tile) {
  const f = [...list].reverse().find(f => f.on !== false && f.img?.naturalWidth && point.x >= f.x && point.x <= f.x + f.img.naturalWidth && point.y >= f.y && point.y <= f.y + f.img.naturalHeight);
  if (!f) return null;
  const width = f.tile, height = f.tileY;
  const left = f.x + f.phaseX + Math.floor((point.x - f.x - f.phaseX) / width) * width;
  const top = f.y + f.phaseY + Math.floor((point.y - f.y - f.phaseY) / height) * height;
  const x = left + width / 2, y = top + height / 2;
  const col = Math.floor((x - origin) / tile); if (col < 0) return null;
  // 显示使用方块中心, 保存的地表高度仍使用上边缘.
  return { col, x, y, surfaceY: top, left, top, width, height, f };
}
