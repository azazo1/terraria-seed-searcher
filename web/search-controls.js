/* 粗筛参数表单与浏览器文件导入导出. */
import { DEFAULT_SEARCH_PARAMETERS, decodeSearchParameters, encodeSearchParameters, normalizeSearchParameters } from './search-parameters.js';
const inputIds = { tol: 'tol', offer: 'offer', spawn_lo: 'spawn-lo', spawn_hi: 'spawn-hi', cols: 'search-cols', scales: 'search-scales', batch: 'search-batch', device: 'search-device' };
export function bindSearchParameters(onError) {
  const get = id => document.getElementById(id); let importVersion = 0;
  const status = (message, failed = false) => { get('search-parameters-status').textContent = message; get('search-parameters-status').className = 'hint ' + (failed ? 'bad' : 'good'); };
  const number = id => { const value = get(id).value.trim(); if (!value) throw new Error('搜索参数不能留空.'); return Number(value); };
  const read = () => normalizeSearchParameters({ ...Object.fromEntries(Object.entries(inputIds).map(([key, id]) => [key, key === 'scales' ? get(id).value : number(id)])), range: [number('seed-from'), number('seed-to')] });
  const write = raw => {
    const parameters = normalizeSearchParameters(raw);
    for (const [key, id] of Object.entries(inputIds)) get(id).value = String(parameters[key]);
    get('seed-from').value = String(parameters.range[0]); get('seed-to').value = String(parameters.range[1]);
  };
  write(DEFAULT_SEARCH_PARAMETERS);
  get('export-search-parameters').onclick = () => {
    try {
      const blob = new Blob([encodeSearchParameters(read())], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = 'terraria-search-parameters.json'; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000); status('参数已导出, 不包含截图, 标注或候选结果.');
    } catch (error) { status(error.message, true); onError?.(error.message, true); }
  };
  get('import-search-parameters').onclick = () => get('search-parameters-file').click();
  get('search-parameters-file').onchange = async event => {
    const file = event.target.files?.[0], version = ++importVersion; if (!file) return;
    try {
      if (file.size > 65536) throw new Error('参数文件不能超过 64 KiB.');
      const parameters = decodeSearchParameters(await file.text());
      if (version !== importVersion) return;
      write(parameters); status('参数已导入, 未启动搜索. 可展开高级参数检查, 再手动开始.');
    } catch (error) { if (version === importVersion) { status(error.message, true); onError?.(error.message, true); } }
    finally { if (version === importVersion) event.target.value = ''; }
  };
  return { read };
}
