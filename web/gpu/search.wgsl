// 中世界粗筛: 整数随机数, 单次地形生成, 并行偏移评分.
struct Settings { start: u32, count: u32, cols: u32, obs_n: u32, scale_n: u32, lo: i32, hi: i32, base: i32, combinations: u32, radius: i32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<uniform> cfg: Settings;
@group(0) @binding(1) var<storage, read> observed: array<i32>;
@group(0) @binding(2) var<storage, read> shifts: array<i32>;
@group(0) @binding(3) var<storage, read_write> profiles: array<i32>;
@group(0) @binding(4) var<storage, read_write> results: array<u32>;
var<private> random_state: array<i32, 56>;
var<private> random_index: u32;
fn seed_rng(seed: i32) {
  for (var i = 0u; i < 56u; i++) { random_state[i] = 0; }
  var a = 161803398 - seed; var b = 1; random_state[55] = a;
  for (var j = 1u; j < 55u; j++) { let k = 21u * j % 55u; random_state[k] = b; b = a - b; if (b < 0) { b += 2147483647; } a = random_state[k]; }
  for (var k = 1u; k < 5u; k++) { for (var j = 1u; j < 56u; j++) { var v = random_state[j] - random_state[1u + (j + 30u) % 55u]; if (v < 0) { v += 2147483647; } random_state[j] = v; } }
  random_index = 0u;
}
fn sample_rng() -> i32 {
  var a = random_index + 1u; if (a > 55u) { a = 1u; } var b = a + 21u; if (b > 55u) { b -= 55u; }
  var v = random_state[a] - random_state[b]; if (v == 2147483647) { v--; } if (v < 0) { v += 2147483647; }
  random_state[a] = v; random_index = a; return v;
}
// 用两个 32 位字完成乘法与 Mersenne 除法, 避免 f32 改变 Next 的分支.
fn scaled_sample(a: u32, b: u32) -> i32 {
  let a0 = a & 65535u; let a1 = a >> 16u; let b0 = b & 65535u; let b1 = b >> 16u;
  let w0 = a0 * b0; let t = a1 * b0 + (w0 >> 16u); let w1 = (t & 65535u) + a0 * b1;
  let hi = a1 * b1 + (t >> 16u) + (w1 >> 16u); let lo = (w1 << 16u) | (w0 & 65535u);
  var q = (hi << 1u) | (lo >> 31u); let remainder = (lo & 2147483647u) + q;
  if (remainder >= 2147483647u) { q++; } return i32(q);
}
fn next_rng(maximum: i32) -> i32 { return scaled_sample(u32(sample_rng()), u32(maximum)); }
fn between_rng(low: i32, high: i32) -> i32 { return next_rng(high - low) + low; }
fn forest() -> i32 {
  var n = next_rng(14); if ((n == 1 || n == 2) && next_rng(2) == 0) { n = next_rng(14); } if (n == 0) { n = next_rng(14); }
  if (n == 3 && next_rng(3) == 0) { n = 31; } if (n == 5 && next_rng(2) == 0) { n = 51; } if (n == 7 && next_rng(4) == 0) { n = between_rng(71, 74); } return n;
}
fn styles(maximum: i32) {
  _ = between_rng(857, 3417); _ = between_rng(2988, 5548); var values: array<i32, 3>;
  for (var j = 0u; j < 3u; j++) { values[j] = next_rng(maximum); }
  while (values[1] == values[0]) { values[1] = next_rng(maximum); }
  while (values[2] == values[0] || values[2] == values[1]) { values[2] = next_rng(maximum); }
  if (maximum == 6) { for (var j = 0u; j < 3u; j++) { if (values[j] == 0 && next_rng(3) != 0) { values[j] = 4; } } }
  else { _ = next_rng(4); _ = next_rng(3); _ = next_rng(2); }
}
fn setup_beach(seed: i32) -> vec2<i32> {
  seed_rng(seed); _ = next_rng(5); _ = next_rng(2); _ = between_rng(10, 200);
  for (var j = 0u; j < 100u; j++) { let value = sample_rng(); _ = next_rng(2); if (value != 0) { break; } }
  for (var j = 5; j >= 1; j--) { _ = next_rng(j); }
  _ = between_rng(172800, 259200); _ = between_rng(8640, 86400);
  for (var j = 0u; j < 5u; j++) { _ = next_rng(2); } _ = next_rng(2147483647);
  styles(6); styles(8); var backgrounds: array<i32, 4>; backgrounds[0] = forest();
  for (var j = 1u; j < 4u; j++) {
    var v = forest();
    loop { var repeated = false; for (var k = 0u; k < j; k++) { if (v == backgrounds[k]) { repeated = true; } } if (!repeated) { break; } v = forest(); }
    backgrounds[j] = v;
  }
  if (next_rng(6) == 5) { _ = next_rng(2); } _ = next_rng(7); var snow = next_rng(9);
  for (var j = 2; j <= 4; j++) { if (snow == j && next_rng(2) == 0) { if (next_rng(2) == 0) { snow = j * 10 + 1; } else { snow = j * 10 + 2; } } }
  _ = next_rng(6); _ = next_rng(7); if (next_rng(6) == 5) { _ = next_rng(5); } _ = next_rng(8); _ = next_rng(5); _ = next_rng(3); _ = next_rng(9);
  let side = next_rng(2); _ = between_rng(15, 30); var dungeon = next_rng(6400);
  let low = select(1600, 3840, side == 1); let high = select(2560, 4800, side == 1);
  while (dungeon < low || dungeon > high) { dungeon = next_rng(6400); }
  for (var j = 0u; j < 2u; j++) { _ = between_rng(50, 90); _ = between_rng(20, 40); _ = between_rng(20, 40); }
  let left = between_rng(300, 340) + select(20, 40, side == 1);
  let right = 6400 - between_rng(300, 340) - select(40, 20, side == 1); return vec2<i32>(left, right);
}
fn surface_offset(kind: i32) -> i32 {
  var v = 0;
  if (kind == 0) { while (next_rng(7) == 0) { v += between_rng(-1, 2); } return v; }
  let down = kind == 1 || kind == 3; let first = select(2, 4, kind <= 2); let second = select(select(5, 6, kind == 3), 10, kind <= 2);
  while (next_rng(first) == 0) { v += select(1, -1, down); } while (next_rng(second) == 0) { v += select(-1, 1, down); } return v;
}
@compute @workgroup_size(32)
fn profile_main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x; if (index >= cfg.count) { return; } let seed = i32(cfg.start + index); let beaches = setup_beach(seed); seed_rng(seed);
  _ = between_rng(90, 110); _ = between_rng(90, 110);
  // 中世界初始地表恒低于海滩下限, 首列必定限制为 306. 此后只做整数增减.
  var surface = 0; var remaining = beaches.x + 5; var kind = 0; let width = u32(cfg.hi - cfg.lo);
  for (var x = 0; x < i32(cfg.cols); x++) {
    if (remaining <= 0) { kind = next_rng(5); remaining = between_rng(5, 40); if (kind == 0) { remaining *= between_rng(5, 30) / 5; } }
    remaining--;
    if (x > 2880 && x < 3520 && (kind == 3 || kind == 4)) { kind = next_rng(3); }
    if (x > 3072 && x < 3328) { kind = 0; }
    surface += surface_offset(kind);
    if (x < beaches.x + 5 || x > beaches.y - 5) { surface = clamp(surface, 306, 414); }
    else if (surface < 306) { surface = 306; remaining = 0; } else if (surface > 468) { surface = 468; remaining = 0; }
    while (next_rng(3) == 0) { _ = between_rng(-2, 3); }
    if (x >= cfg.lo && x < cfg.hi) { profiles[index * width + u32(x - cfg.lo)] = surface * 8; }
  }
}
var<workgroup> best_scores: array<u32, 64>;
var<workgroup> best_offsets: array<u32, 64>;
@compute @workgroup_size(64)
fn score_main(@builtin(workgroup_id) group: vec3<u32>, @builtin(local_invocation_index) lane: u32) {
  let index = group.x; let width = u32(cfg.hi - cfg.lo); var best = 0u; var best_q = 0u;
  for (var q = lane; q < cfg.combinations; q += 64u) {
    let base = cfg.base + i32(q / cfg.scale_n); let scale = q % cfg.scale_n;
    var hist: array<u32, 33>; for (var k = 0u; k < 33u; k++) { hist[k] = 0u; }
    var first = 0; var have = false; var count = 0u;
    for (var j = 0u; j < cfg.obs_n; j++) {
      if (observed[j] == bitcast<i32>(2147483648u)) { continue; }
      let x = base + shifts[scale * cfg.obs_n + j]; if (x < cfg.lo || x >= cfg.hi) { continue; }
      let d = profiles[index * width + u32(x - cfg.lo)] - observed[j]; if (!have) { first = d; have = true; }
      let bin = d - first; if (bin >= -16 && bin <= 16) { hist[u32(bin + 16)]++; } count++;
    }
    if (count < 20u) { continue; } var accumulated = 0u; var median = 16;
    for (var k = 0u; k < 33u; k++) { accumulated += hist[k]; if (accumulated >= count / 2u) { median = i32(k); break; } }
    var hits = 0u; for (var k = max(0, median - cfg.radius); k <= min(32, median + cfg.radius); k++) { hits += hist[u32(k)]; }
    let weighted = hits * 10000u;
    let score = (weighted / count) * 1000u + ((weighted % count) * 1000u) / count;
    if (score > best || (score == best && q > best_q)) { best = score; best_q = q; }
  }
  best_scores[lane] = best; best_offsets[lane] = best_q; workgroupBarrier();
  for (var step = 32u; step > 0u; step /= 2u) {
    if (lane < step) { let other = lane + step; if (best_scores[other] > best_scores[lane] || (best_scores[other] == best_scores[lane] && best_offsets[other] > best_offsets[lane])) { best_scores[lane] = best_scores[other]; best_offsets[lane] = best_offsets[other]; } }
    workgroupBarrier();
  }
  if (lane == 0u) { results[index * 2u] = best_scores[0]; results[index * 2u + 1u] = best_offsets[0]; }
}
