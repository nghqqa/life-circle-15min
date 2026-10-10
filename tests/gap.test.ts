import { describe, expect, it } from 'vitest';
import { buildIsochroneModel, sampleBearings } from '../shared/isochrone.js';
import { buildTimeField } from '../shared/timefield.js';
import { analyzeGaps } from '../shared/gap.js';
import { destination } from '../shared/geo.js';
import { generateMockPois, mockDetourFactor } from '../shared/mock.js';
import { computeScore } from '../shared/scoring.js';
import { planFacilitiesFromCoverage } from '../shared/planner.js';
import { CORE_CATEGORIES } from '../shared/config.js';
import type { Poi } from '../shared/types.js';

const CENTER = { lat: 30.0, lng: 120.0 };

function makeField(minutes = 15, speed = 80, f = 1.25) {
  const dirs = 48;
  const probes = sampleBearings(dirs).map(() => ({ ok: true, distM: speed * minutes * f }));
  const model = buildIsochroneModel(CENTER, probes, { dirs, minutes, speed });
  return buildTimeField(model, { n: 41, cellM: 150 });
}

describe('盲区识别', () => {
  it('东侧有设施、西侧无设施 → 西侧形成灰色斑块', () => {
    const field = makeField();
    const pois: Poi[] = [];
    // 核心三件套放在东侧 600m
    for (const cat of ['market', 'pharmacy', 'primarySchool'] as const) {
      const p = destination(CENTER, 90, 600);
      pois.push({ uid: cat, name: cat, lat: p.lat, lng: p.lng, category: cat, source: 'mock' });
      const p2 = destination(CENTER, 60, 500);
      pois.push({ uid: cat + '2', name: cat + '2', lat: p2.lat, lng: p2.lng, category: cat, source: 'mock' });
    }
    // 住宅小区：东侧 3 个 + 西侧 4 个（1.2km 外，离设施远）
    for (let i = 0; i < 3; i++) {
      const p = destination(CENTER, 80, 400 + i * 150);
      pois.push({ uid: 're' + i, name: '东小区' + i, lat: p.lat, lng: p.lng, category: 'residential', source: 'mock' });
    }
    for (let i = 0; i < 4; i++) {
      const p = destination(CENTER, 270, 800 + i * 120);
      pois.push({ uid: 'rw' + i, name: '西小区' + i, lat: p.lat, lng: p.lng, category: 'residential', source: 'mock' });
    }
    const gap = analyzeGaps(field, pois, { coreRadiusM: 1000, minPatchCells: 4 });
    expect(gap.patches.length).toBeGreaterThan(0);
    // 西侧小区（远）权重应主要落在 missing >= 2 区域
    expect(gap.coverageShare).toBeLessThan(1);
    expect(gap.blindPoints).toBeGreaterThan(0);
  });

  it('设施全覆盖时无斑块，有居住采样时覆盖率 100%', () => {
    const field = makeField();
    const pois: Poi[] = [];
    // 四角 + 中心都有三件套 → 全覆盖
    const spots = [0, 90, 180, 270];
    for (const b of spots) {
      for (const cat of ['market', 'pharmacy', 'primarySchool'] as const) {
        const p = destination(CENTER, b, 350);
        pois.push({ uid: `${cat}${b}`, name: cat, lat: p.lat, lng: p.lng, category: cat, source: 'mock' });
      }
    }
    // 中心放一个住宅小区，使覆盖率口径可评估
    pois.push({ uid: 'res0', name: '中心小区', lat: CENTER.lat, lng: CENTER.lng, category: 'residential', source: 'mock' });
    const gap = analyzeGaps(field, pois, { coreRadiusM: 1000, minPatchCells: 4 });
    expect(gap.patches.length).toBe(0);
    expect(gap.coverageUnavailable).toBe(false);
    expect(gap.coverageShare).toBe(1);
  });

  it('无居住采样时覆盖率不可评估（null，不再误报 100%）', () => {
    const field = makeField();
    const pois: Poi[] = [];
    for (const b of [0, 90, 180, 270]) {
      for (const cat of ['market', 'pharmacy', 'primarySchool'] as const) {
        const p = destination(CENTER, b, 350);
        pois.push({ uid: `${cat}${b}`, name: cat, lat: p.lat, lng: p.lng, category: cat, source: 'mock' });
      }
    }
    const gap = analyzeGaps(field, pois, { coreRadiusM: 1000, minPatchCells: 4 });
    expect(gap.coverageUnavailable).toBe(true);
    expect(gap.coverageShare).toBeNull();
  });
});

describe('演示数据', () => {
  it('确定性：同一种子生成相同 POI 集合', () => {
    expect(generateMockPois(CENTER, 42)).toEqual(generateMockPois(CENTER, 42));
  });

  it('西侧盲区带内没有核心设施', () => {
    const pois = generateMockPois(CENTER, 42);
    const core = pois.filter((p) => (CORE_CATEGORIES as string[]).includes(p.category));
    const inWest = core.filter((p) => {
      const dLng = p.lng - CENTER.lng;
      const dLat = p.lat - CENTER.lat;
      const bearing = (Math.atan2(dLng, dLat) * 180) / Math.PI;
      return bearing > 250 && bearing < 292;
    });
    expect(inWest.length).toBe(0);
  });

  it('绕行系数模型在合理区间', () => {
    for (let t = 0; t < 360; t += 5) {
      const f = mockDetourFactor(t);
      expect(f).toBeGreaterThanOrEqual(1.0);
      expect(f).toBeLessThanOrEqual(1.6);
    }
  });
});

describe('评分与规划', () => {
  it('评分在 0-100 且维度齐备', () => {
    const field = makeField();
    const pois = generateMockPois(CENTER, 42);
    const gap = analyzeGaps(field, pois);
    const score = computeScore(CENTER, pois, gap);
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(100);
    expect(score.details.length).toBe(10);
    expect(score.summary.length).toBeGreaterThan(0);
  });

  it('选址引擎：西侧盲区给出建议且覆盖率单调提升', () => {
    const field = makeField();
    const pois: Poi[] = [];
    // 核心三件套全部在东侧 500-600m
    for (const cat of ['market', 'pharmacy', 'primarySchool', 'clinic'] as const) {
      const p = destination(CENTER, 90, 550);
      pois.push({ uid: cat, name: cat, lat: p.lat, lng: p.lng, category: cat, source: 'mock' });
    }
    // 住宅小区：西侧 900-1100m（盲区带）+ 东侧正常覆盖
    for (let i = 0; i < 8; i++) {
      const p = destination(CENTER, 268 + (i % 4) * 3, 920 + i * 25);
      pois.push({ uid: 'rw' + i, name: '西小区' + i, lat: p.lat, lng: p.lng, category: 'residential', source: 'mock' });
    }
    for (let i = 0; i < 4; i++) {
      const p = destination(CENTER, 80, 400 + i * 120);
      pois.push({ uid: 're' + i, name: '东小区' + i, lat: p.lat, lng: p.lng, category: 'residential', source: 'mock' });
    }
    const gap = analyzeGaps(field, pois, { minPatchCells: 4 });
    expect(gap.patches.length).toBeGreaterThan(0);
    const sites = planFacilitiesFromCoverage(gap, gap.coveredMasks, field, 80);
    expect(sites.length).toBeGreaterThan(0);
    // 贪心性质：逐轮收益单调不增
    for (let i = 1; i < sites.length; i++) {
      expect(sites[i].coveredWeight).toBeLessThanOrEqual(sites[i - 1].coveredWeight);
    }
    const first = sites[0];
    expect(first.afterPct).toBeGreaterThan(first.beforePct);
    expect(first.coveredCells).toBeGreaterThan(0);
    expect(first.rationale).toContain('补建');
  });
});
