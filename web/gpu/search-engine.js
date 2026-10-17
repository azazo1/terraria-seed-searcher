/* WebGPU 调度与设备结果对拍, 每批释放执行权以支持停止和页面交互. */
import { prepareSearch, scoreProfile, terrainProfile, worldGeometry } from './terrain-reference.js';
const U = { MAP_READ: 1, COPY_SRC: 4, COPY_DST: 8, UNIFORM: 64, STORAGE: 128 };
export class BrowserSearch {
  constructor() { this.cancelled = false; this.resources = []; }
  stop() { this.cancelled = true; }
  async initialize() {
    if (!globalThis.isSecureContext || !navigator.gpu) throw new Error('当前浏览器未提供 WebGPU. 请使用支持 WebGPU 的浏览器, 并通过 localhost 或 HTTPS 打开页面.');
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('没有可用的 WebGPU 适配器. 请检查浏览器 GPU 设置或使用 CUDA 搜索.');
    this.device = await adapter.requestDevice(); const device = this.device;
    this.failure = null; device.lost.then(info => { this.failure = new Error('WebGPU 设备已断开: ' + info.message); });
    device.addEventListener('uncapturederror', event => { this.failure = new Error(event.error.message); });
    const response = await fetch(new URL('./search.wgsl', import.meta.url)); if (!response.ok) throw new Error('无法加载 WebGPU 搜索内核.');
    const module = device.createShaderModule({ code: await response.text() });
    const compilation = await module.getCompilationInfo(); const errors = compilation.messages.filter(message => message.type === 'error');
    if (errors.length) throw new Error('WGSL 编译失败: ' + errors.map(message => `${message.lineNum}: ${message.message}`).join('; '));
    const layout = device.createBindGroupLayout({ entries: [
      { binding: 0, visibility: 4, buffer: { type: 'uniform' } },
      ...[1, 2].map(binding => ({ binding, visibility: 4, buffer: { type: 'read-only-storage' } })),
      ...[3, 4].map(binding => ({ binding, visibility: 4, buffer: { type: 'storage' } }))
    ] });
    this.layout = layout; const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
    [this.profilePipeline, this.scorePipeline] = await Promise.all(['profile_main', 'score_main'].map(entryPoint => device.createComputePipelineAsync({ layout: pipelineLayout, compute: { module, entryPoint } })));
    this.adapterInfo = [adapter.info?.vendor, adapter.info?.architecture, adapter.info?.device].filter(Boolean).join(' ') || 'WebGPU 适配器';
    return this;
  }
  buffer(dataOrSize, usage) {
    const data = typeof dataOrSize === 'number' ? null : dataOrSize;
    const buffer = this.device.createBuffer({ size: Math.max(4, data ? data.byteLength : dataOrSize), usage }); this.resources.push(buffer);
    if (data) this.device.queue.writeBuffer(buffer, 0, data); return buffer;
  }
  releaseBatch() { for (const buffer of this.resources.splice(0)) buffer.destroy(); }
  async dispatch(start, count, observation, parameters, { profilesOnly = false } = {}) {
    if (this.failure) throw this.failure;
    const p = prepareSearch(observation, parameters), width = p.hi - p.lo, device = this.device, g = p.geometry;
    const uniform = new Int32Array([start, count, parameters.cols, p.obs8.length, p.scales.length, p.lo, p.hi, p.base, p.combinations,
      Math.floor(parameters.tol * 8 + 1e-6), g.width, g.rollLo, g.rollHi, g.plateauLo, g.plateauHi, g.surfMin, g.surfBeach, g.surfMax,
      g.dungeonLo0, g.dungeonHi0, g.dungeonLo1, g.dungeonHi1, g.surfMinEps ? 1 : 0]);
    const buffers = [this.buffer(uniform, U.UNIFORM | U.COPY_DST), this.buffer(p.obs8, U.STORAGE | U.COPY_DST), this.buffer(p.shifts, U.STORAGE | U.COPY_DST), this.buffer(count * width * 4, U.STORAGE | U.COPY_SRC), this.buffer(count * 8, U.STORAGE | U.COPY_SRC)];
    const group = device.createBindGroup({ layout: this.layout, entries: buffers.map((buffer, binding) => ({ binding, resource: { buffer } })) });
    const size = profilesOnly ? count * width * 4 : count * 8, readback = this.buffer(size, U.MAP_READ | U.COPY_DST);
    device.pushErrorScope('validation');
    try {
      const encoder = device.createCommandEncoder(); const pass = encoder.beginComputePass(); pass.setBindGroup(0, group);
      pass.setPipeline(this.profilePipeline); pass.dispatchWorkgroups(Math.ceil(count / 32));
      if (!profilesOnly) { pass.setPipeline(this.scorePipeline); pass.dispatchWorkgroups(count); }
      pass.end(); encoder.copyBufferToBuffer(buffers[profilesOnly ? 3 : 4], 0, readback, 0, size); device.queue.submit([encoder.finish()]);
      await readback.mapAsync(1); const result = new Uint32Array(readback.getMappedRange().slice(0)); readback.unmap();
      if (this.failure) throw this.failure; return result;
    } finally { const error = await device.popErrorScope(); this.releaseBatch(); if (error) throw new Error('WebGPU 执行失败: ' + error.message); }
  }
  async selfTest() {
    // 覆盖低种子, 初始化常量两侧和 int32 上边界. 全宽剖面对拍会覆盖两端海滩和出生区.
    const observation = { heights: Array(20).fill(0), marker: 0 };
    let columns = 0;
    /* 三个世界尺寸都要对拍: 分段窗口和地表下限随尺寸变, 中世界过了不代表小世界过大世界也过. */
    for (const world of ['small', 'medium', 'large']) {
      const geometry = worldGeometry(world);
      const parameters = { cols: geometry.width, spawn_lo: 0, spawn_hi: geometry.width - 1, scales: '1.00', tol: .5, world };
      for (const start of [0, 161803397, 2147483643]) {
        if (this.cancelled) return null;
        const actual = await this.dispatch(start, 4, observation, parameters, { profilesOnly: true });
        for (let index = 0; index < 4; index++) {
          const expected = terrainProfile(start + index, geometry.width, world);
          for (let x = 0; x < geometry.width; x++) { if (actual[index * geometry.width + x] !== expected[x]) throw new Error(`GPU 地形对拍失败: ${world} seed=${start + index}, x=${x}, GPU=${actual[index * geometry.width + x]}, CPU=${expected[x]}. 已停止搜索.`); columns++; }
        }
      }
    }
    const profile = terrainProfile(42, 3400), heights = Array.from(profile.slice(3100, 3196), (y, index) => index % 7 === 0 ? -999 : (y - profile[3100]) / 8 + 30);
    const obs = { heights, marker: 100 }, settings = { cols: 3400, spawn_lo: 3198, spawn_hi: 3202, scales: '.97,1.00,1.03', tol: .5 };
    const actual = await this.dispatch(42, 1, obs, settings), expected = scoreProfile(profile, obs, settings);
    if (actual[0] !== expected.quantized || actual[1] !== expected.q) throw new Error(`GPU 评分对拍失败: GPU=${actual[0]}/${actual[1]}, CPU=${expected.quantized}/${expected.q}. 已停止搜索.`);
    return { seeds: 12, columns, scoring: true };
  }
  async run(observation, parameters, onProgress) {
    const prepared = prepareSearch(observation, parameters), from = parameters.range[0], to = parameters.range[1]; let next = from, batch = 32, scanned = 0;
    const maximum = Math.max(1, Math.min(512, parameters.batch, Math.floor(this.device.limits.maxStorageBufferBindingSize / ((prepared.hi - prepared.lo) * 4)), this.device.limits.maxComputeWorkgroupsPerDimension));
    const started = performance.now();
    while (next < to && !this.cancelled) {
      const count = Math.min(batch, maximum, to - next), before = performance.now();
      const results = await this.dispatch(next, count, observation, parameters), candidates = [];
      for (let index = 0; index < count; index++) { const score = results[index * 2] / 10000000, q = results[index * 2 + 1]; if (score < parameters.offer || score === 0) continue;
        candidates.push({ seed: next + index, score, spawn: prepared.base + Math.floor(q / prepared.scales.length) + prepared.marker, scale: prepared.scales[q % prepared.scales.length] });
      }
      next += count; scanned += count;
      await onProgress({ next, scanned, total: to - from, elapsed: (performance.now() - started) / 1000, candidates, batch: count });
      const elapsed = performance.now() - before; batch = elapsed > 150 ? Math.max(1, Math.floor(count / 2)) : elapsed < 40 ? Math.min(maximum, count * 2) : count;
      await new Promise(resolve => setTimeout(resolve, 0));
    }
    return { cancelled: this.cancelled, next, scanned };
  }
  destroy() { this.releaseBatch(); this.device?.destroy(); }
}
