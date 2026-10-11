import { describe, expect, it } from 'vitest';
import { buildIsochroneModel, buildTimeField, planFacilitiesFromCoverage } from '../shared/index.js';
import type { GapAnalysis, RouteProbe } from '../shared/types.js';

const center = { lat: 28.46, lng: 117.97 };
const probes: RouteProbe[] = Array.from({ length: 16 }, () => ({ ok: true, distM: 1320 }));
const model = buildIsochroneModel(center, probes, { dirs: 16, minutes: 15, speed: 80 });
const field = buildTimeField(model, { n: 21, cellM: 120 });
const N = field.n;

/** 全缺 + 居住权重集中在中心 5×5 的合成片区 */
function fixtureGap(): GapAnalysis {
  const size = N * N;
  const weight = new Float64Array(size);
  const ci = Math.floor(N / 2), cj = Math.floor(N / 2);
  for (let i = ci - 2; i <= ci + 2; i++) {
    for (let j = cj - 2; j <= cj + 2; j++) weight[i * N + j] = 100;
  }
  const total = weight.reduce((a, b) => a + b, 0);
  const zero = () => new Uint8Array(size);
  return {
    n: N, cellM: 120, weightGrid: weight, totalWeight: total,
    missingGrid: new Uint8Array(size),
    coveredMasks: { market: zero(), pharmacy: zero(), primarySchool: zero() },
    patches: [], unknownCategories: [], coverageShare: 0, severeShare: 0,
    coverageUnavailable: false, blindPoints: 25
  };
}

describe('规划编辑与预算约束（№7/8）', () => {
  it('无约束时给出多条建议', () => {
    const sites = planFacilitiesFromCoverage(fixtureGap(), fixtureGap().coveredMasks, field, 80);
    expect(sites.length).toBeGreaterThanOrEqual(2);
  });

  it('maxSites 限制输出条数', () => {
    const gap = fixtureGap();
    const sites = planFacilitiesFromCoverage(gap, gap.coveredMasks, field, 80, { budget: { maxSites: 1 } });
    expect(sites.length).toBe(1);
  });

  it('总预算 / 单点成本折算数量上限', () => {
    const gap = fixtureGap();
    const sites1 = planFacilitiesFromCoverage(gap, gap.coveredMasks, field, 80, { budget: { costPerSiteWan: 20, totalBudgetWan: 30 } });
    const sites2 = planFacilitiesFromCoverage(gap, gap.coveredMasks, field, 80, { budget: { costPerSiteWan: 20, totalBudgetWan: 60 } });
    expect(sites1.length).toBe(1);
    expect(sites2.length).toBeGreaterThanOrEqual(2);
  });

  it('禁建区排除区域内候选', () => {
    const gap = fixtureGap();
    const zones = [{ center, radiusM: 100000 }];
    const sites = planFacilitiesFromCoverage(gap, gap.coveredMasks, field, 80, { noGoZones: zones });
    expect(sites.length).toBe(0);
  });

  it('自定义候选参与竞价并带「自定义候选落点」标注', () => {
    const gap = fixtureGap();
    const sites = planFacilitiesFromCoverage(gap, gap.coveredMasks, field, 80, {
      customCandidates: [{ latLng: center, category: 'market' }]
    });
    expect(sites.length).toBeGreaterThan(0);
    expect(sites.some((s) => s.rationale.startsWith('自定义候选落点'))).toBe(true);
  });

  it('禁建区内的自定义候选被排除', () => {
    const gap = fixtureGap();
    const sites = planFacilitiesFromCoverage(gap, gap.coveredMasks, field, 80, {
      customCandidates: [{ latLng: center, category: 'market' }],
      noGoZones: [{ center, radiusM: 100000 }]
    });
    expect(sites.length).toBe(0);
  });
});
