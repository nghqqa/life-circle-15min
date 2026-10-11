import { CATEGORIES } from './config.js';
import { destination } from './geo.js';
import type { CategoryId, LatLng, Poi } from './types.js';

/**
 * 演示模式数据源（也是三级降级的兜底层）：
 * 确定性伪随机生成一个「西侧存在服务盲区」的典型社区。
 *
 * 几何设计：核心设施全部布置在东侧（方位角 5°-180°、距离 ≤700m），
 * 西侧 880-1100m 布置住宅小区聚集带 —— 与任何设施直线距离均 >1km，
 * 保证灰色斑块与规划建议在该场景下稳定复现。
 */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 演示用绕行系数：模拟道路网格的方向性（南北向绕行更强） */
export function mockDetourFactor(thetaDeg: number): number {
  const t = (thetaDeg * Math.PI) / 180;
  const f = 1.12 + 0.22 * Math.abs(Math.sin(2 * t)) + 0.06 * Math.sin(5 * t + 0.8);
  return Math.min(1.6, Math.max(1.0, f));
}

interface Spec {
  category: CategoryId;
  count: number;
  bearings: [number, number];
  dist: [number, number];
  names: string[];
}

const SPECS: Spec[] = [
  { category: 'market', count: 5, bearings: [10, 175], dist: [250, 700], names: ['惠民菜市场', '农贸市场的', '生鲜市集'] },
  { category: 'pharmacy', count: 7, bearings: [5, 180], dist: [200, 650], names: ['同仁堂药店', '健民大药房', '老百姓大药房'] },
  { category: 'primarySchool', count: 3, bearings: [15, 160], dist: [400, 700], names: ['实验小学', '第一小学', '师范附小'] },
  { category: 'kindergarten', count: 5, bearings: [0, 185], dist: [150, 600], names: ['实验幼儿园', '阳光幼儿园', '小哈佛幼儿园'] },
  { category: 'clinic', count: 3, bearings: [10, 170], dist: [200, 650], names: ['社区卫生服务中心', '康民诊所'] },
  { category: 'hospital', count: 2, bearings: [60, 130], dist: [650, 950], names: ['市中心医院', '人民医院分院'] },
  { category: 'supermarket', count: 8, bearings: [0, 185], dist: [150, 800], names: ['永辉超市', '物美超市', '华润万家'] },
  { category: 'elderly', count: 1, bearings: [80, 110], dist: [600, 800], names: ['老年日间照料中心'] },
  { category: 'busStop', count: 12, bearings: [0, 190], dist: [100, 850], names: ['公交站'] },
  { category: 'park', count: 3, bearings: [110, 180], dist: [400, 900], names: ['滨河公园', '市民广场', '街心公园'] }
];

export function generateMockPois(center: LatLng, seed = 42): Poi[] {
  const rng = mulberry32(seed);
  const pois: Poi[] = [];

  // 住宅小区：西侧 262°-282° / 880-1100m 为无设施聚集带；东、南、北为正常覆盖区
  const residentialClusters: { bearing: number; dist: number }[] = [];
  for (let i = 0; i < 9; i++) residentialClusters.push({ bearing: 262 + rng() * 20, dist: 880 + rng() * 220 });
  for (let i = 0; i < 7; i++) residentialClusters.push({ bearing: 20 + rng() * 120, dist: 300 + rng() * 550 });
  for (let i = 0; i < 6; i++) residentialClusters.push({ bearing: 150 + rng() * 60, dist: 300 + rng() * 450 });
  const resNames = ['幸福', '康居', '和平', '朝阳', '锦园', '翠竹', '梅苑', '兰亭'];
  residentialClusters.forEach((c, i) => {
    const p = destination(center, c.bearing, c.dist);
    pois.push({
      uid: `mock-res-${i}`,
      name: `${resNames[i % 8]}小区${i > 7 ? i : ''}`,
      lat: p.lat,
      lng: p.lng,
      category: 'residential',
      source: 'mock'
    });
  });

  for (const spec of SPECS) {
    for (let i = 0; i < spec.count; i++) {
      const bearing = spec.bearings[0] + rng() * (spec.bearings[1] - spec.bearings[0]);
      const dist = spec.dist[0] + rng() * (spec.dist[1] - spec.dist[0]);
      const p = destination(center, bearing, dist);
      pois.push({
        uid: `mock-${spec.category}-${i}`,
        name: `${spec.names[i % spec.names.length]}${i >= spec.names.length ? i + 1 : ''}`,
        lat: p.lat,
        lng: p.lng,
        category: spec.category,
        address: '演示数据',
        source: 'mock'
      });
    }
  }
  return pois;
}
