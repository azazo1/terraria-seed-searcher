/* CPU, CUDA 和 WebGPU 共用的进度展示. */
const number = value => Math.round(value).toLocaleString('en-US');
export function progressDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '--';
  const s = Math.ceil(seconds), days = Math.floor(s / 86400), hours = Math.floor(s / 3600) % 24, minutes = Math.floor(s / 60) % 60;
  return days ? `${days} 天 ${hours} 小时` : hours ? `${hours} 小时 ${minutes} 分` : minutes ? `${minutes} 分 ${s % 60} 秒` : `${s} 秒`;
}
export function renderSearchProgress(get, progress, backend) {
  const panel = get('search-progress'); panel.hidden = !progress;
  if (!progress) return;
  const labels = { preparing: '准备中', running: '搜索中', stopping: '正在停止', stopped: '已停止', completed: '已完成', failed: '搜索失败' };
  const scanned = Math.max(0, Math.min(progress.total, progress.scanned)), fraction = progress.total > 0 ? scanned / progress.total : 0;
  const rate = progress.rate ?? (scanned > 0 && progress.elapsed > 0 ? scanned / progress.elapsed : null);
  const eta = progress.eta ?? (rate && progress.status === 'running' ? (progress.total - scanned) / rate : null);
  panel.dataset.status = progress.status;
  get('progress-backend').textContent = { cpu: '主机 CPU', cuda: '主机 CUDA', webgpu: '浏览器 WebGPU' }[backend];
  get('progress-status').textContent = labels[progress.status] || '准备中';
  const percent = fraction * 100;
  get('progress-percent').textContent = percent > 0 && percent < .01 ? '< 0.01%' : `${percent.toFixed(2)}%`;
  const bar = get('search-progress-bar'); bar.max = 1; bar.value = fraction;
  get('progress-scanned').textContent = `${number(scanned)} / ${number(progress.total)}`;
  get('progress-rate').textContent = rate ? `${number(rate)} seeds/s` : '正在估算';
  get('progress-elapsed').textContent = progressDuration(progress.elapsed);
  get('progress-eta').textContent = progress.status === 'completed' ? '已完成' : eta !== null && Number.isFinite(eta) ? `约 ${progressDuration(eta)}` : progress.status === 'running' || progress.status === 'preparing' ? '正在估算' : '--';
  get('progress-candidates').textContent = number(progress.candidates || 0);
  get('progress-remaining').textContent = number(progress.total - scanned);
  get('progress-note').textContent = progress.status === 'running' ? backend === 'cuda' ? '每批完成后更新计数. 速度为本次平均值, 剩余时间会随计算速度变化.' : '速度为本次平均值, 剩余时间会随计算速度变化.' : progress.status === 'preparing' ? '正在准备设备并校验计算结果, 首批完成后显示速度和剩余时间.' : progress.status === 'failed' ? '搜索未正常完成, 请查看运行输出. 已发布的候选仍可查看.' : progress.status === 'stopped' || progress.status === 'stopping' ? '显示已确认完成的扫描量. 已发布的候选仍可查看.' : '本次扫描已完成. 候选还需要结合游戏内地形进一步核对.';
}
