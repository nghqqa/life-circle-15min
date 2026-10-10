import { CATEGORY_MAP } from './config.js';
import { nearestPoiM } from './poi.js';
import type { ChecklistItem, LatLng, Poi } from './types.js';

/**
 * 「完整社区」参考对标清单。
 * 阈值参考《完整居住社区建设标准（试行）》（住建部 2020）与《社区生活圈规划技术指南》
 * （TD/T 1062-2021）的通行口径取整，作为可配置的参考基线，非规范原文距离。
 * 检索失败的类别按「无法判断」处理，不输出「缺失」结论。
 */

const ITEMS: { id: string; name: string; category: keyof typeof CATEGORY_MAP | string; thresholdM: number; basis: string }[] = [
  { id: 'clinic', name: '社区卫生服务站（含诊所）', category: 'clinic', thresholdM: 1000, basis: '完整居住社区标准：步行可达的基层医疗' },
  { id: 'pharmacy', name: '药店', category: 'pharmacy', thresholdM: 500, basis: '便民商业服务口径' },
  { id: 'market', name: '菜市场/生鲜网点', category: 'market', thresholdM: 800, basis: '完整居住社区标准：便民商业' },
  { id: 'primarySchool', name: '小学', category: 'primarySchool', thresholdM: 1000, basis: '赛题口径 + 生活圈导则' },
  { id: 'kindergarten', name: '幼儿园', category: 'kindergarten', thresholdM: 500, basis: '完整居住社区标准' },
  { id: 'elderly', name: '养老服务设施', category: 'elderly', thresholdM: 1000, basis: '完整居住社区标准：老年服务' },
  { id: 'busStop', name: '公交站', category: 'busStop', thresholdM: 300, basis: '城市居住区规划设计标准' },
  { id: 'park', name: '公园绿地/广场', category: 'park', thresholdM: 1000, basis: '完整居住社区标准：公共活动场地' },
  { id: 'supermarket', name: '综合超市', category: 'supermarket', thresholdM: 800, basis: '便民商业服务口径' },
  { id: 'hospital', name: '医院（门诊级以上）', category: 'hospital', thresholdM: 3000, basis: '参考口径：医院允许较大服务半径' }
];

export function buildChecklist(
  center: LatLng,
  pois: Poi[],
  opts: { failedCategories?: string[] } = {}
): ChecklistItem[] {
  const failed = new Set(opts.failedCategories ?? []);
  return ITEMS.map((item) => {
    const unavailable = failed.has(String(item.category));
    const list = unavailable ? [] : pois.filter((p) => p.category === item.category);
    const nearest = unavailable ? null : nearestPoiM(center, list);
    return {
      id: item.id,
      name: item.name,
      basis: item.basis,
      thresholdM: item.thresholdM,
      met: unavailable ? null : nearest != null && nearest.distM <= item.thresholdM,
      unavailable,
      nearestM: nearest ? Math.round(nearest.distM) : null,
      count: list.length
    };
  });
}
