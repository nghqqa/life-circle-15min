import { describe, expect, it } from 'vitest';
import { buildIsochroneModel, sampleBearings } from '../shared/isochrone.js';
import { buildTimeField } from '../shared/timefield.js';
import { analyzeGaps } from '../shared/gap.js';
import { computeScore } from '../shared/scoring.js';
import { buildChecklist } from '../shared/checklist.js';
import { planFacilitiesFromCoverage } from '../shared/planner.js';
import { destination } from '../shared/geo.js';
import type { CategoryId, LatLng, Poi, TimeField } from '../shared/types.js';

/**
 * 场景级回归（eval）：构造三个确定性 fixture 社区，
 * 断言「体检 → 盲区 → 评分 → 规划」端到端行为符合预期，
 * 防止后续算法改动破坏产品语义（区别于纯函数单测）。
 */

const CENTER: LatLng = { lat: 30.0, lng: 120.0 };

function makeField(minutes = 15, speed = 80, f = 1.25): TimeField {
  const dirs = 48;
  const probes = sampleBearings(dirs).map(() => ({ ok: true, distM: speed * minutes * f }));
  const model = buildIsochroneModel(CENTER, probes, { dirs, minutes, speed });
  return buildTimeField(model, { n: 41, cellM: 150 });
}

function poi(cat: CategoryId, name: string, bearing: number, distM: number): Poi {
  const p = destination(CENTER, bearing, distM);
  return { uid: `${cat}-${name}`, name, lat: p.lat, lng: p.lng, category: cat, source: 'mock' };
}

/** 各方向都投放一组设施，半径可调 */
function plantRing(pois: Poi[], cat: CategoryId, prefix: string, bearings: number[], distM: number) {
  bearings.forEach((b, i) => pois.push(poi(cat, `${prefix}${i}`, b, distM)));
}

const ALL_BEARINGS = [0, 45, 90, 135, 180, 225, 270, 315];

function buildPois(opts: { without?: CategoryId[] } = {}): Poi[] {
  const pois: Poi[] = [];
  const core: [CategoryId, string, number][] = [
    ['market', '菜市场', 400],
    ['pharmacy', '药店', 350],
    ['primarySchool', '小学', 600]
  ];
  for (const [cat, name, d] of core) {
    if (opts.without?.includes(cat)) continue;
    plantRing(pois, cat, name, ALL_BEARINGS, d);
  }
  const extras: [CategoryId, string, number][] = [
    ['hospital', '医院', 900],
    ['clinic', '诊所', 300],
    ['supermarket', '超市', 200],
    ['kindergarten', '幼儿园', 250],
    ['elderly', '养老院', 700],
    ['busStop', '公交站', 150],
    ['park', '公园', 500]
  ];
  for (const [cat, name, d] of extras) {
    if (opts.without?.includes(cat)) continue;
    plantRing(pois, cat, name, [0, 90, 180, 270], d);
  }
  // 住宅小区：中心密集分布
  for (let i = 0; i < 8; i++) {
    pois.push(poi('residential', `小区${i}`, i * 45 + 20, 300 + (i % 3) * 150));
  }
  return pois;
}

function analyze(pois: Poi[]) {
  const field = makeField();
  const gap = analyzeGaps(field, pois, { minPatchCells: 4 });
  const score = computeScore(CENTER, pois, gap);
  const checklist = buildChecklist(CENTER, pois);
  const sites = planFacilitiesFromCoverage(gap, gap.coveredMasks, field, 80);
  return { field, gap, score, checklist, sites };
}

describe('eval · 完美社区', () => {
  const pois = buildPois();
  const { gap, score, sites } = analyze(pois);

  it('评分达到 A/B 级（≥75）', () => {
    expect(score.total).toBeGreaterThanOrEqual(75);
    expect(['A', 'B']).toContain(score.grade);
  });
  it('三件套全覆盖：人口覆盖率 100%、无灰色斑块、盲区点位为 0', () => {
    expect(gap.coverageShare).toBe(1);
    expect(gap.patches.length).toBe(0);
    expect(gap.blindPoints).toBe(0);
  });
  it('无补点建议', () => {
    expect(sites.length).toBe(0);
  });
  it('国标清单全部达标', () => {
    const checklist = buildChecklist(CENTER, pois);
    expect(checklist.every((c) => c.met)).toBe(true);
  });
  it('确定性：同输入两次运行结果一致', () => {
    const again = analyze(buildPois());
    expect(again.score.total).toBe(score.total);
    expect(again.gap.patches.length).toBe(gap.patches.length);
  });
});

describe('eval · 单缺药店社区', () => {
  const pois = buildPois({ without: ['pharmacy'] });
  const { gap, score, checklist, sites } = analyze(pois);

  it('药店完整度为 0，国标清单对应项不达标', () => {
    const pharmacy = score.details.find((d) => d.category === 'pharmacy');
    expect(pharmacy?.completeness).toBe(0);
    const item = checklist.find((c) => c.id === 'pharmacy');
    expect(item?.met).toBe(false);
  });
  it('只缺一类时不形成灰色斑块（斑块定义为缺 ≥2 项），但覆盖率下降', () => {
    expect(gap.patches.length).toBe(0);
    expect(gap.coverageShare).toBeLessThan(1);
  });
  it('规划引擎仍应给出药店补点建议（覆盖「缺 1 类」场景）', () => {
    expect(sites.length).toBeGreaterThan(0);
    expect(sites[0].category).toBe('pharmacy');
  });
  it('总分为各场景中受缺一类影响的合理区间（≤ 完美社区）', () => {
    const perfect = computeScore(CENTER, buildPois(), analyzeGaps(makeField(), buildPois(), { minPatchCells: 4 }));
    expect(score.total).toBeLessThan(perfect.total);
  });
});

describe('eval · 盲区社区（西侧只有居住）', () => {
  const field = makeField();
  const pois: Poi[] = [];
  // 核心三件套全部在东侧 500-600m
  for (const cat of ['market', 'pharmacy', 'primarySchool'] as CategoryId[]) {
    pois.push(poi(cat, String(cat), 90, 550));
  }
  // 住宅：西侧 900-1100m 盲区带 + 东侧正常覆盖
  for (let i = 0; i < 8; i++) pois.push(poi('residential', `西小区${i}`, 266 + (i % 4) * 4, 920 + i * 22));
  for (let i = 0; i < 4; i++) pois.push(poi('residential', `东小区${i}`, 80, 400 + i * 120));
  const gap = analyzeGaps(field, pois, { minPatchCells: 4 });
  const sites = planFacilitiesFromCoverage(gap, gap.coveredMasks, field, 80);

  it('识别出西侧灰色斑块且主缺失为核心类别', () => {
    expect(gap.patches.length).toBeGreaterThan(0);
    const top = gap.patches[0];
    expect(top.weightShare).toBeGreaterThan(0);
    expect(['market', 'pharmacy', 'primarySchool']).toContain(top.dominant);
  });
  it('规划引擎给出补点建议且收益为正', () => {
    expect(sites.length).toBeGreaterThan(0);
    expect(sites[0].afterPct).toBeGreaterThan(sites[0].beforePct);
  });
  it('评分显著低于完美社区', () => {
    const score = computeScore(CENTER, pois, gap);
    const perfectScore = computeScore(CENTER, buildPois(), analyzeGaps(makeField(), buildPois(), { minPatchCells: 4 }));
    expect(score.total).toBeLessThan(perfectScore.total - 20);
  });
});
