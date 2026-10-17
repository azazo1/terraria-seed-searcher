/* 粗筛设置默认值与校验, 不包含最终观测数据. */
export const DEFAULT_SEARCH_PARAMETERS = Object.freeze({ tol: .5, offer: .55, range: Object.freeze([0, 2147483647]), spawn_lo: 3180, spawn_hi: 3220, cols: 3400, scales: '1.00', batch: 1000000, device: 0 });
const fields = Object.keys(DEFAULT_SEARCH_PARAMETERS);
export function normalizeSearchParameters(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || fields.some(key => !(key in raw)) || Object.keys(raw).some(key => !fields.includes(key))) throw new Error('搜索参数字段不完整或包含不支持的字段.');
  const number = (key, min, max, integer = false) => {
    const value = raw[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isSafeInteger(value))) throw new Error(`${key} 必须是 ${min}-${max} 范围内的${integer ? '整数' : '数值'}.`);
    return value;
  };
  if (!Array.isArray(raw.range) || raw.range.length !== 2 || raw.range.some(value => !Number.isSafeInteger(value) || value < 0 || value > 2147483647) || raw.range[0] >= raw.range[1]) throw new Error('种子范围必须是递增的两个非负整数, 结束值不包含在范围内.');
  const result = { tol: number('tol', .01, 10), offer: number('offer', 0, 1), range: [...raw.range], spawn_lo: number('spawn_lo', 0, 8399, true), spawn_hi: number('spawn_hi', 0, 8399, true), cols: number('cols', 1, 8400, true), scales: raw.scales, batch: number('batch', 1, 2147483647, true), device: number('device', -1, 1024, true) };
  if (result.spawn_lo > result.spawn_hi || result.spawn_hi >= result.cols) throw new Error('出生点范围必须递增或相等, 且不能超出模拟列数.');
  if (typeof result.scales !== 'string') throw new Error('搜索尺度必须是英文逗号分隔的数值.');
  const scales = result.scales.split(',').map(s => s.trim());
  if (!scales.length || scales.length > 8 || scales.some(s => !/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(s) || Number(s) < .1 || Number(s) > 10)) throw new Error('搜索尺度应为 1-8 个 0.1-10 范围内的数值, 用英文逗号分隔.');
  result.scales = scales.join(','); return result;
}
