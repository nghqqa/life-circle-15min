import { describe, it, expect } from 'vitest';
import { captureScenario, comparisonBaseline, measurePlan } from '../shared/comparison.js';
import { createProject, parseProject, serializeProject } from '../src/projects.js';
import type { PlanSite } from '../shared/types.js';
import { comparisonFixture } from './fixtures/comparison.js';

function weightedExample() {
  const r = comparisonFixture();
  const step = 1200, lngStep = step / (111320 * Math.cos(r.center.lat * Math.PI / 180));
  Object.assign(r.field, { n: 3, latMax: r.center.lat + step / 111320, lngMin: r.center.lng - lngStep, t: new Float64Array(9).fill(1) });
  Object.assign(r.gap, { n: 3, weightGrid: Float64Array.from([0, 0, 0, 1, 3, 2, 0, 0, 0]), totalWeight: 6,
    coverageShare: 1 / 6, coverageUnavailable: false, coveredMasks: { market: new Uint8Array(9).fill(1), pharmacy: new Uint8Array(9).fill(1), primarySchool: Uint8Array.from([0, 0, 0, 1, 0, 0, 0, 0, 0]) } });
  const a: PlanSite = { ...r.planSites[0], category: 'primarySchool', latLng: { ...r.center } };
  const b: PlanSite = { ...a, latLng: { lat: r.center.lat, lng: r.center.lng + lngStep } };
  return { r, a, b };
}
describe('同基线方案对比', () => {
  it('按住宅权重计算新增覆盖，服务盘重复不重复计数且不改写现状', () => {
    const { r, a, b } = weightedExample(), original = r.gap.coveredMasks.primarySchool.slice();
    expect(measurePlan(r, []).coverage).toBeCloseTo(1 / 6);
    const one = measurePlan(r, [a, structuredClone(a)]);
    expect(one.siteCount).toBe(1);
    expect(one.coverage).toBeCloseTo(4 / 6);
    expect(one.gainPoints).toBeCloseTo(50);
    expect(one.remainingCells).toBe(1);
    expect(one.remainingShare).toBeCloseTo(2 / 6);
    const both = measurePlan(r, [a, b]);
    expect(both.coverage).toBe(1); expect(both.remainingCells).toBe(0);
    expect(both.gainPoints).toBeCloseTo(100 * 5 / 6);
    expect(r.gap.coveredMasks.primarySchool).toEqual(original);
  });
  it('不同设施类别不能把单类改善冒充三件套改善', () => {
    const { r, a } = weightedExample(); r.gap.coveredMasks.pharmacy.fill(0);
    expect(measurePlan(r, [a]).coverage).toBe(0);
    expect(measurePlan(r, [a, { ...a, category: 'pharmacy' }]).coverage).toBeCloseTo(3 / 6);
  });
  it.each(['residential', 'pharmacy', 'market', 'primarySchool'] as const)('不完整的 %s 不提供提升结论', category => {
    const { r, a } = weightedExample(); r.assessmentUnavailableCategories = [category];
    expect(measurePlan(r, [a])).toMatchObject({ coverage: null, gainPoints: null, remainingCells: null });
  });
  it('无住宅权重及历史规则保留未知值', () => {
    const { r, a } = weightedExample(); r.gap.weightGrid.fill(0);
    expect(measurePlan(r, [a]).coverage).toBeNull();
    const old = comparisonFixture(); old.provenance!.ruleVersion = 'old';
    expect(measurePlan(old, []).reason).toContain('历史规则');
  });
  it('相同参数但不同采样、掩码、规则或报告不能混比', () => {
    const { r, a } = weightedExample(), key = comparisonBaseline(r);
    for (const mutate of [
      (x: typeof r) => x.pois[0].name = '更新采样', (x: typeof r) => x.gap.coveredMasks.market[0] = 0,
      (x: typeof r) => x.provenance!.ruleFingerprint = 'changed', (x: typeof r) => x.provenance!.reportId = 'different',
      (x: typeof r) => x.minutes = 10
    ]) {
      const copy = structuredClone(r); mutate(copy);
      expect(measurePlan(copy, [a], key).reason).toContain('不能比较');
    }
  });
  it('保存不共享可变选择，A/B随项目导入导出保留且与旧项目兼容', () => {
    const r = comparisonFixture(), state = { acceptedSites: [r.planSites[0]], rejectedSites: [r.planSites[1]] };
    const a = captureScenario(r, state); state.acceptedSites.length = 0;
    expect(a.acceptedSites).toHaveLength(1);
    const project = createProject(r, { ...state, scenarios: { A: a, B: captureScenario(r, state) } }, '方案测试');
    const restored = parseProject(serializeProject(project));
    expect(restored.workbench).toEqual(project.workbench);
    expect(measurePlan(restored.result, a.acceptedSites, a.baselineKey).reason).toBeUndefined();
    expect(createProject(r, state, '旧格式').workbench.scenarios).toBeUndefined();
  });
  it('拒绝混入另一份体检的方案，保护原项目', () => {
    const r = comparisonFixture(), state = { acceptedSites: [], rejectedSites: [] };
    const other = comparisonFixture();
    expect(() => createProject(r, { ...state, scenarios: { A: captureScenario(other, state) } }, '混合')).toThrow('基线不一致');
  });
});
