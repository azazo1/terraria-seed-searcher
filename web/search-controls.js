/* 粗筛设置表单, 与最终搜索观测的数据传输分离. */
import { DEFAULT_SEARCH_PARAMETERS, normalizeSearchParameters } from './search-parameters.js';
const inputIds = { tol: 'tol', offer: 'offer', spawn_lo: 'spawn-lo', spawn_hi: 'spawn-hi', cols: 'search-cols', scales: 'search-scales', batch: 'search-batch', device: 'search-device' };
export function bindSearchParameters() {
  const get = id => document.getElementById(id);
  const number = id => { const value = get(id).value.trim(); if (!value) throw new Error('搜索参数不能留空.'); return Number(value); };
  for (const [key, id] of Object.entries(inputIds)) get(id).value = String(DEFAULT_SEARCH_PARAMETERS[key]);
  get('seed-from').value = String(DEFAULT_SEARCH_PARAMETERS.range[0]); get('seed-to').value = String(DEFAULT_SEARCH_PARAMETERS.range[1]);
  return { read: () => normalizeSearchParameters({ ...Object.fromEntries(Object.entries(inputIds).map(([key, id]) => [key, key === 'scales' ? get(id).value : number(id)])), range: [number('seed-from'), number('seed-to')] }) };
}
