/* WebGPU 对拍参考: 保留现有 CUDA 的双精度随机数和中世界地形语义.
 *
 * 世界表与 src/world-geometry.h, internal/task/model.go 的 WorldGeometry 一一对应:
 * 分段窗口由 WorldGen 的双精度比较导出, [rollLo, rollHi] 等价于 x > w*0.45 && x < w*0.55,
 * [plateauLo, plateauHi] 等价于 x > w*0.48 && x < w*0.52; 地表限制取 h*0.17 / 0.23 / 0.26.
 * 三个世界尺寸上这些都是精确整数.
 */
export const WORLDS = Object.freeze({
  small: Object.freeze({ name: 'small', width: 4200, height: 1200, rollLo: 1891, rollHi: 2309, plateauLo: 2017, plateauHi: 2183, surfMin: 204, surfMinEps: 1, surfBeach: 276, surfMax: 312, dungeonLo0: 1050, dungeonHi0: 1680, dungeonLo1: 2520, dungeonHi1: 3150 }),
  medium: Object.freeze({ name: 'medium', width: 6400, height: 1800, rollLo: 2881, rollHi: 3520, plateauLo: 3073, plateauHi: 3327, surfMin: 306, surfMinEps: 0, surfBeach: 414, surfMax: 468, dungeonLo0: 1600, dungeonHi0: 2560, dungeonLo1: 3840, dungeonHi1: 4800 }),
  large: Object.freeze({ name: 'large', width: 8400, height: 2400, rollLo: 3781, rollHi: 4619, plateauLo: 4033, plateauHi: 4367, surfMin: 408, surfMinEps: 1, surfBeach: 552, surfMax: 624, dungeonLo0: 2100, dungeonHi0: 3360, dungeonLo1: 5040, dungeonHi1: 6300 })
});
export function worldGeometry(world) { return WORLDS[world] || WORLDS.medium; }

export class UnifiedRandom {
  constructor(seed) { this.sa = new Int32Array(56); this.index = 0; let a = (161803398 - Math.abs(seed)) | 0, b = 1; this.sa[55] = a;
    for (let j = 1; j < 55; j++) { const k = 21 * j % 55; this.sa[k] = b; b = (a - b) | 0; if (b < 0) b = (b + 2147483647) | 0; a = this.sa[k]; }
    for (let k = 1; k < 5; k++) for (let j = 1; j < 56; j++) { let v = (this.sa[j] - this.sa[1 + (j + 30) % 55]) | 0; if (v < 0) v = (v + 2147483647) | 0; this.sa[j] = v; }
  }
  sample() { let a = this.index + 1; if (a > 55) a = 1; let b = a + 21; if (b > 55) b -= 55; let v = (this.sa[a] - this.sa[b]) | 0; if (v === 2147483647) v--; if (v < 0) v = (v + 2147483647) | 0; this.sa[a] = v; this.index = a; return v; }
  next(max) { return Math.trunc(this.sample() * 4.656612875245797e-10 * max); }
  between(min, max) { return this.next(max - min) + min; }
}
function forest(r) {
  let n = r.next(14); if ((n === 1 || n === 2) && r.next(2) === 0) n = r.next(14); if (n === 0) n = r.next(14);
  if (n === 3 && r.next(3) === 0) n = 31; if (n === 5 && r.next(2) === 0) n = 51; if (n === 7 && r.next(4) === 0) n = r.between(71, 74); return n;
}
function styles(r, max) {
  r.between(857, 3417); r.between(2988, 5548); const values = [r.next(max), r.next(max), r.next(max)];
  while (values[1] === values[0]) values[1] = r.next(max);
  while (values[2] === values[0] || values[2] === values[1]) values[2] = r.next(max);
  if (max === 6) { for (let i = 0; i < 3; i++) if (values[i] === 0 && r.next(3) !== 0) values[i] = 4; }
  else { r.next(4); r.next(3); r.next(2); }
}
function beach(seed, geometry) {
  const r = new UnifiedRandom(seed), w = geometry.width; r.next(5); r.next(2); r.between(10, 200);
  for (let i = 0; i < 100; i++) { const f = r.sample() * 4.656612875245797e-10, v = f * .35 * (r.next(2) * 2 - 1); if (v !== 0) break; }
  for (let i = 5; i >= 1; i--) r.next(i);
  r.between(172800, 259200); r.between(8640, 86400); for (let i = 0; i < 5; i++) r.next(2); r.next(2147483647);
  styles(r, 6); styles(r, 8);
  const backgrounds = [forest(r)]; for (let k = 1; k < 4; k++) { let v = forest(r); while (backgrounds.includes(v)) v = forest(r); backgrounds.push(v); }
  if (r.next(6) === 5) r.next(2); r.next(7); let snow = r.next(9);
  for (let k = 2; k <= 4; k++) if (snow === k && r.next(2) === 0) snow = r.next(2) === 0 ? k * 10 + 1 : k * 10 + 2;
  r.next(6); r.next(7); if (r.next(6) === 5) r.next(5); r.next(8); r.next(5); r.next(3); r.next(9);
  const side = r.next(2); r.between(15, 30); let dungeon = r.next(w);
  const low = side ? geometry.dungeonLo1 : geometry.dungeonLo0, high = side ? geometry.dungeonHi1 : geometry.dungeonHi0;
  while (dungeon < low || dungeon > high) dungeon = r.next(w);
  for (let i = 0; i < 2; i++) { r.between(50, 90); r.between(20, 40); r.between(20, 40); }
  return [r.between(300, 340) + (side ? 40 : 20), w - r.between(300, 340) - (side ? 20 : 40)];
}
function offset(r, feature) {
  let v = 0;
  if (feature === 0) { while (r.next(7) === 0) v += r.between(-1, 2); return v; }
  const down = feature === 1 || feature === 3, first = feature <= 2 ? 4 : 2, second = feature <= 2 ? 10 : feature === 3 ? 6 : 5;
  while (r.next(first) === 0) v += down ? -1 : 1; while (r.next(second) === 0) v += down ? 1 : -1; return v;
}
export function terrainProfile(seed, cols, world = 'medium') {
  const geometry = worldGeometry(world), [left, right] = beach(seed, geometry), r = new UnifiedRandom(seed), out = new Int32Array(cols);
  /* 地表按 (整数, 是否带下限的极小正偏移) 记录. 下限 H*0.17 在小世界和大世界不是整数
   * (204.00000000000003 / 408.00000000000006), 差这一格会改变钳制与随机数消耗.
   * 首个海滩分支必把地表钳到下限, 所以初值直接取下限; 初始高度的随机数消耗照旧. */
  const eps = geometry.surfMinEps ? 1 : 0;
  let tile = geometry.surfMin, above = eps;
  let rock = geometry.height * .3 * r.between(90, 110) * .005;
  rock = (rock + geometry.height * .2) * (r.between(90, 110) * .01);
  let remaining = left + 5, feature = 0;
  for (let x = 0; x < cols; x++) {
    if (remaining <= 0) { feature = r.between(0, 5); remaining = r.between(5, 40); if (feature === 0) remaining *= Math.trunc(r.between(5, 30) * .2); }
    remaining--;
    if (x > geometry.width * .45 && x < geometry.width * .55 && (feature === 3 || feature === 4)) feature = r.next(3);
    if (x > geometry.width * .48 && x < geometry.width * .52) feature = 0;
    tile += offset(r, feature);
    const underMin = eps ? (above ? tile < geometry.surfMin : tile <= geometry.surfMin) : tile < geometry.surfMin;
    if (x < left + 5 || x > right - 5) { if (underMin) { tile = geometry.surfMin; above = eps; } else if (tile > geometry.surfBeach) { tile = geometry.surfBeach; above = 0; } }
    else if (underMin) { tile = geometry.surfMin; above = eps; remaining = 0; }
    else if (tile > geometry.surfMax) { tile = geometry.surfMax; above = 0; remaining = 0; }
    while (r.next(3) === 0) rock += r.between(-2, 3);
    out[x] = tile * 8;
  }
  return out;
}
export function prepareSearch(observation, parameters) {
  const heights = observation?.heights;
  if (!Array.isArray(heights) || !heights.length || heights.length > 700) throw new Error('浏览器粗筛支持 1-700 个观测列, 与当前 CUDA 内核一致.');
  if (heights.some(v => typeof v !== 'number' || !Number.isFinite(v) || (v !== -999 && (v < 0 || v > 1000000))) || !Number.isSafeInteger(observation.marker) || observation.marker < 0 || observation.marker >= 100000) throw new Error('最终观测包含无效高度或出生点列号.');
  if (heights.filter(v => v !== -999).length < 20) throw new Error('粗筛需要至少 20 个有效观测列.');
  const geometry = worldGeometry(parameters.world);
  if (parameters.cols > geometry.width) throw new Error(`当前浏览器内核支持 ${geometry.width} x ${geometry.height} 世界, 模拟列数不能超过 ${geometry.width}.`);
  const scales = parameters.scales.split(',').map(Number), obs8 = Int32Array.from(heights, h => h === -999 ? -2147483648 : Math.trunc(h * 8 + (h >= 0 ? .5 : -.5)));
  const shifts = Int32Array.from(scales.flatMap(scale => heights.map((_, j) => Math.trunc(j * scale + .5))));
  const base = parameters.spawn_lo - observation.marker, count = parameters.spawn_hi - parameters.spawn_lo + 1;
  const lo = Math.max(0, base), hi = Math.min(parameters.cols, base + count + Math.max(...shifts));
  if (hi <= lo) throw new Error('出生点范围和观测列号没有覆盖模拟区域.');
  const combinations = count * scales.length;
  return { obs8, shifts, scales, base, count, lo, hi, combinations, marker: observation.marker, geometry };
}
export function scoreProfile(profile, observation, parameters) {
  const p = prepareSearch(observation, parameters); let best = { score: 0, quantized: 0, q: 0, valid: 0 };
  for (let q = 0; q < p.combinations; q++) {
    const base = p.base + Math.floor(q / p.scales.length), scale = q % p.scales.length, hist = new Int32Array(33); let count = 0, first;
    for (let j = 0; j < p.obs8.length; j++) { if (p.obs8[j] === -2147483648) continue; const x = base + p.shifts[scale * p.obs8.length + j]; if (x < p.lo || x >= p.hi) continue;
      const d = profile[x] - p.obs8[j]; if (first === undefined) first = d; const bin = d - first; if (bin >= -16 && bin <= 16) hist[bin + 16]++; count++;
    }
    if (count < 20) continue;
    let accumulated = 0, median = 16; for (let k = 0; k < 33; k++) { accumulated += hist[k]; if (accumulated >= Math.floor(count / 2)) { median = k; break; } }
    let hits = 0; const radius = Math.floor(parameters.tol * 8 + 1e-6); for (let k = Math.max(0, median - radius); k <= Math.min(32, median + radius); k++) hits += hist[k];
    const quantized = Math.floor(hits * 10000000 / count), score = quantized / 10000000; if (quantized > best.quantized || (quantized === best.quantized && q > best.q)) best = { score, quantized, q, valid: count };
  }
  return { ...best, spawn: p.base + Math.floor(best.q / p.scales.length) + p.marker, scale: p.scales[best.q % p.scales.length] };
}
