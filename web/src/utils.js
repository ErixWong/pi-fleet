// 共享展示工具（视图层通用，避免双份漂移）

/** 周期标签：none/daily/hourly/weekly:<0-6> → 中文 */
export function recLabel(r) {
  return { none: '一次性', daily: '每天', hourly: '每小时' }[r]
    || (r.startsWith('weekly:') ? `每周${'日一二三四五六'[Number(r.split(':')[1])]}` : r);
}
