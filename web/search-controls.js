/* 粗筛设置表单, 与最终搜索观测的数据传输分离. 出生点范围由服务端按世界规则推导. */
import { DEFAULT_SEARCH_PARAMETERS, normalizeSearchParameters } from './search-parameters.js';
const inputIds = { tol: 'tol', offer: 'offer', cols: 'search-cols', scales: 'search-scales', batch: 'search-batch', device: 'search-device', world: 'search-world' };
export function bindSearchParameters() {
  const get = id => document.getElementById(id);
  const number = id => { const value = get(id).value.trim(); if (!value) throw new Error('搜索参数不能留空.'); return Number(value); };
  for (const [key, id] of Object.entries(inputIds)) get(id).value = String(DEFAULT_SEARCH_PARAMETERS[key]);
  get('seed-from').value = String(DEFAULT_SEARCH_PARAMETERS.range[0]); get('seed-to').value = String(DEFAULT_SEARCH_PARAMETERS.range[1]);
  // 模拟列数要盖住出生点附近的窗口, 换世界尺寸时给出对应默认值.
  const colsByWorld = { small: 2300, medium: 3400, large: 4400 };
  get('search-world')?.addEventListener('change', () => { const cols = colsByWorld[get('search-world').value]; if (cols) get('search-cols').value = String(cols); });
  const write = raw => {
    const parameters = normalizeSearchParameters(raw);
    for (const [key, id] of Object.entries(inputIds)) get(id).value = String(parameters[key]);
    get('seed-from').value = String(parameters.range[0]); get('seed-to').value = String(parameters.range[1]);
  };
  return { write, read: () => normalizeSearchParameters({ ...DEFAULT_SEARCH_PARAMETERS, ...Object.fromEntries(Object.entries(inputIds).map(([key, id]) => [key, key === 'scales' || key === 'world' ? get(id).value : number(id)])), range: [number('seed-from'), number('seed-to')] }) };
}
