/* 最终搜索观测的浏览器文件导入导出, 不包含截图或编辑布局. */
export function bindObservationTransfer({ run, exportData, importData, onError }) {
  const get = id => document.getElementById(id);
  const status = (message, failed = false) => { get('observation-status').textContent = message; get('observation-status').className = 'hint ' + (failed ? 'bad' : 'good'); };
  const failure = error => { status(error.message, true); onError(error.message, true); };
  get('export-observation').onclick = async () => {
    try {
      await run(async () => {
        const observation = await exportData();
        const blob = new Blob([JSON.stringify(observation, null, 2) + '\n'], { type: 'application/json;charset=utf-8' });
        const url = URL.createObjectURL(blob), link = document.createElement('a');
        link.href = url; link.download = 'terraria-observation.json'; document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      });
      status('已导出最终逐列高度和出生点观测列号.');
    } catch (error) { failure(error); }
  };
  get('import-observation').onclick = () => get('observation-file').click();
  get('observation-file').onchange = async event => {
    const file = event.target.files?.[0]; if (!file) return;
    try {
      await run(async () => {
        if (file.size > 8 * 1024 * 1024) throw new Error('观测文件不能超过 8 MiB.');
        let observation;
        try { observation = JSON.parse((await file.text()).replace(/^\uFEFF/, '')); } catch { throw new Error('观测文件不是有效的 JSON.'); }
        if (observation?.format !== 'terraria-seed-searcher/observation' || observation.version !== 1) throw new Error('请选择最终观测文件, 不是搜索设置或画布参数文件.');
        if (!confirm('导入会替换当前用于搜索的观测数据, 不会恢复或修改标注画布. 是否继续?')) { status('已取消导入.'); return; }
        await importData(observation); status('最终观测已导入, 可直接用于搜索. 未启动搜索.');
      });
    } catch (error) { failure(error); }
    finally { event.target.value = ''; }
  };
}
