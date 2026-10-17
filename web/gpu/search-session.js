/* 浏览器搜索会话: 独立候选结果, 阶段日志和可取消 GPU 调度. */
import { BrowserSearch } from './search-engine.js';
import { prepareSearch } from './terrain-reference.js';
export class SearchSession {
  constructor(onChange, engineFactory = () => new BrowserSearch()) { this.onChange = onChange; this.engineFactory = engineFactory; this.running = false; this.rows = []; this.messages = []; this.hasRun = false; this.summary = null; this.matched = 0; }
  log(message) { this.messages.push(`[${new Date().toLocaleTimeString('zh-CN', { hour12: false })}] ${message}`); if (this.messages.length > 80) this.messages.shift(); this.onChange(); }
  get progress() {
    if (!this.hasRun) return null;
    return { scanned: this.summary?.scanned || 0, total: this.seedRange[1] - this.seedRange[0], next: this.summary?.next ?? this.seedRange[0], candidates: this.matched, elapsed: ((this.finishedAt ?? performance.now()) - this.startedAt) / 1000, status: this.status };
  }
  stop() { if (!this.running) return; this.status = 'stopping'; this.engine?.stop(); this.log('正在停止, 等待当前 GPU 批次返回...'); }
  async start(observation, parameters) {
    if (this.running) throw new Error('浏览器搜索正在运行.');
    prepareSearch(observation, parameters); this.running = true; this.hasRun = true; this.rows = []; this.messages = []; this.matched = 0; this.summary = null;
    this.seedRange = [...parameters.range]; this.startedAt = performance.now(); this.finishedAt = null; this.status = 'preparing';
    this.engine = this.engineFactory();
    this.log(`准备 WebGPU, 种子范围 [${parameters.range[0]}, ${parameters.range[1]}), 中世界 6400 x 1800.`);
    try {
      await this.engine.initialize(); if (this.engine.cancelled) return;
      this.log(`${this.engine.adapterInfo}. 正在执行设备地形和评分自检...`);
      const checked = await this.engine.selfTest(); if (this.engine.cancelled) return;
      this.log(`自检通过: ${checked.seeds} 个种子, ${checked.columns} 列及评分一致. 开始分批搜索.`);
      let lastLog = -Infinity;
      const result = await this.engine.run(observation, parameters, progress => {
        if (this.status !== 'stopping') this.status = 'running';
        this.summary = progress; this.matched += progress.candidates.length;
        this.rows.push(...progress.candidates); this.rows.sort((a, b) => b.score - a.score || a.seed - b.seed); this.rows.length = Math.min(this.rows.length, 2000);
        if (progress.elapsed - lastLog >= 1 || progress.scanned === progress.total) {
          lastLog = progress.elapsed;
          this.log(`已扫 ${progress.scanned} / ${progress.total} (${(100 * progress.scanned / progress.total).toFixed(3)}%), ${(progress.scanned / Math.max(.001, progress.elapsed)).toFixed(0)} seeds/s, 候选 ${this.matched}, 下一种子 ${progress.next}.`);
        } else this.onChange();
      });
      this.status = result.cancelled ? 'stopped' : 'completed';
      this.log(`${result.cancelled ? '已停止' : '搜索完成'}, 本次扫描 ${result.scanned} 个种子, 下一种子 ${result.next}. 保留得分最高的 ${this.rows.length} 条候选.`);
    } catch (error) { this.status = 'failed'; this.log('搜索失败: ' + error.message); throw error; }
    finally { const cancelled = this.engine.cancelled; this.engine.destroy(); this.engine = null; this.running = false; this.finishedAt = performance.now(); if (cancelled && this.status !== 'failed') this.status = 'stopped'; if (cancelled && !this.summary) this.log('已在准备阶段停止.'); this.onChange(); }
  }
  lines() { return this.rows.map(row => `seed=${row.seed} spawn_x=${row.spawn} scale=${row.scale.toFixed(3)} score=${row.score.toFixed(7)}`); }
  download() {
    const blob = new Blob([this.lines().join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }), url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = 'candidates-webgpu.txt'; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
