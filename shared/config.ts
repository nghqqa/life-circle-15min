import type { CategoryDef, CategoryId, LatLng, PersonaDef, PersonaId } from './types.js';

/** 民生设施分类体系：3 个核心类别对应评分细则（1km 内无菜市场/药店/小学即盲区） */
export const CATEGORIES: CategoryDef[] = [
  { id: 'hospital', name: '医院', color: '#e53935', keywords: ['医院'], ideal: 3, weight: 1.0, scored: true },
  { id: 'clinic', name: '社区诊所', color: '#ef6c00', keywords: ['社区卫生服务中心', '诊所'], ideal: 3, weight: 1.5, scored: true },
  { id: 'pharmacy', name: '药店', color: '#8e24aa', keywords: ['药店', '药房'], ideal: 6, weight: 2.0, core: true, scored: true },
  { id: 'market', name: '菜市场', color: '#2e7d32', keywords: ['菜市场', '农贸市场', '生鲜超市'], ideal: 5, weight: 2.0, core: true, scored: true },
  { id: 'supermarket', name: '商超', color: '#00838f', keywords: ['超市', '购物中心'], ideal: 10, weight: 1.0, scored: true },
  { id: 'primarySchool', name: '小学', color: '#f9a825', keywords: ['小学'], ideal: 3, weight: 2.0, core: true, scored: true },
  { id: 'kindergarten', name: '幼儿园', color: '#fdd835', keywords: ['幼儿园'], ideal: 4, weight: 1.5, scored: true },
  { id: 'elderly', name: '养老服务', color: '#6d4c41', keywords: ['养老院', '老年日间照料'], ideal: 2, weight: 1.5, scored: true },
  { id: 'busStop', name: '公交站', color: '#1e88e5', keywords: ['公交站'], ideal: 10, weight: 1.0, scored: true },
  { id: 'park', name: '公园绿地', color: '#43a047', keywords: ['公园', '广场'], ideal: 4, weight: 1.0, scored: true },
  { id: 'residential', name: '住宅小区', color: '#5c6bc0', keywords: ['住宅小区', '小区'], ideal: 0, weight: 0, scored: false }
];

export const CATEGORY_MAP: Record<CategoryId, CategoryDef> = Object.fromEntries(
  CATEGORIES.map((c) => [c.id, c])
) as Record<CategoryId, CategoryDef>;

export const CORE_CATEGORIES: CategoryId[] = CATEGORIES.filter((c) => c.core).map((c) => c.id);

/** 人群差异化步行速度（米/分钟）。参考《城市综合交通体系规划标准》步行速率区间取整。 */
export const PERSONAS: PersonaDef[] = [
  { id: 'adult', name: '一般成人', speed: 80, note: '常规步行速度' },
  { id: 'elderly', name: '老年人', speed: 52, note: '含步速放缓与过街等待折减' },
  { id: 'child', name: '儿童(陪同)', speed: 65, note: '学龄儿童陪同出行速度' }
];

export const PERSONA_MAP: Record<PersonaId, PersonaDef> = Object.fromEntries(
  PERSONAS.map((p) => [p.id, p])
) as Record<PersonaId, PersonaDef>;

export const THRESHOLDS = {
  /** 核心三件套盲区判定半径（直线，米）——与评分细则“周边1公里”口径一致 */
  coreRadiusM: 1000,
  /** 住宅小区作为人口代理的权重半径（米） */
  residentialRadiusM: 200,
  /** POI 检索半径（米） */
  searchRadiusM: 2000,
  /** 等时圈扇形采样方向数 */
  sampleDirs: 48,
  /** 单次批量算路的起终点对上限（低于百度接口上限，留安全余量） */
  routeBatchSize: 20,
  /** 盲区斑块最小格数（避免碎斑） */
  minPatchCells: 6,
  /** 规划引擎输出上限 */
  planTopK: 3
};

export const GRADE_THRESHOLDS = { A: 90, B: 75, C: 60, D: 40 };

/** 示例样例社区（可替换为自己城市的社区/街道） */
export const SAMPLE_ADDRESS = '江西省上饶市江西师范大学数字产业学院';

/** 默认中心点（BD-09 坐标：江西师范大学数字产业学院；演示模式与初次加载使用） */
export const DEFAULT_CENTER: LatLng = { lat: 28.505089, lng: 118.023892 };
