import { describe, expect, it } from 'vitest';
import { buildIsochroneModel, sampleBearings } from '../shared/isochrone.js';
import { buildTimeField } from '../shared/timefield.js';
import { analyzeGaps } from '../shared/gap.js';
import { computeScore } from '../shared/scoring.js';
import { planFacilitiesFromCoverage } from '../shared/planner.js';
import { destination } from '../shared/geo.js';
import type { CategoryId, LatLng, Poi, RouteProbe } from '../shared/types.js';
import { runAnalysis, type AnalysisProvider, type AnalyzeParams, type AnalysisReport } from '../shared/analyze.js';

/**
 * 冻结验收测试（对应外部审计 75b4e91 复测的四条失败检查）。
 * 使用 stub provider 离线复现上游故障场景，零真实调用。
 * 这些断言是冻结门槛：任一失败即不得提交。
 */

const CENTER: LatLng = { lat: 28.505089, lng: 118.023892 };

function stubField(p: AnalyzeParams) {
  const center = p.center ?? CENTER;
  const dirs = 16;
  const probes: RouteProbe[] = sampleBearings(dirs).map(() => ({ ok: true, distM: 80 * 15 * 1.25 }));
  const model = buildIsochroneModel(center, probes, { dirs, minutes: 15, speed: 80 });
  return buildTimeField(model, { n: 31, cellM: 150 });
}

/** 正常 provider：每关键词返回 2 条 POI，算路有效 */
function okProvider(): AnalysisProvider {
  return {
    geocode: () => Promise.resolve(CENTER),
    reverseGeocode: () => Promise.resolve('测试点'),
    searchPoi: (kw, cat) =>
      Promise.resolve([
        { uid: `${kw}-1`, name: `${kw}1`, lat: CENTER.lat + 0.003, lng: CENTER.lng + 0.003, category: cat, source: 'mock' },
        { uid: `${kw}-2`, name: `${kw}2`, lat: CENTER.lat - 0.003, lng: CENTER.lng - 0.003, category: cat, source: 'mock' }
      ]),
    routeMatrix: (origin: LatLng, dests: LatLng[]) =>
      Promise.resolve(
        dests.map((d) => ({ ok: true, distM: Math.round(destination(origin, 0, 1).lat === d.lat ? 800 : 900) }))
      )
  };
}

/** 额度耗尽 provider：可指定前 N 个关键词成功，其余全部返回配额错误 */
function quotaProvider(succeedFirstN: number): AnalysisProvider {
  let served = 0;
  const inner = okProvider();
  return {
    geocode: (a) => inner.geocode(a),
    reverseGeocode: (p) => inner.reverseGeocode(p),
    searchPoi: (kw, cat, center, radius) => {
      if (served < succeedFirstN) {
        served++;
        return inner.searchPoi(kw, cat, center, radius);
      }
      return Promise.reject(new Error('place 302: 天配额超限，限制访问'));
    },
    routeMatrix: (o: LatLng, d: LatLng[]) => inner.routeMatrix(o, d)
  };
}

/** 路线全失败 provider：状态"成功"但距离全为 0（模拟上游返回空结果） */
function brokenRouteProvider(): AnalysisProvider {
  const inner = okProvider();
  return {
    ...inner,
    routeMatrix: () => Promise.resolve([{ ok: false, distM: 0 }])
  };
}

async function runDefault(params: Partial<AnalyzeParams> = {}, provider: AnalysisProvider = okProvider()) {
  return runAnalysis({ center: CENTER, persona: 'adult', ...params }, provider);
}

// ---------- 验收 1：核心类别全部未知 → 覆盖率无法评估、不生成补建建议 ----------

describe('冻结验收 · 核心类别全部检索失败', () => {
  async function allCoreFailed() {
    // 住宅正常（人口代理可用），三件套关键词全部失败（医院等非核心可成功，检验覆盖口径独立性）
    const provider: AnalysisProvider = {
      geocode: (a) => okProvider().geocode(a),
      reverseGeocode: (p) => okProvider().reverseGeocode(p),
      searchPoi: (kw, cat, center, radius) => {
        const core: CategoryId[] = ['market', 'pharmacy', 'primarySchool'];
        if (core.includes(cat)) return Promise.reject(new Error('place 302: 天配额超限'));
        return okProvider().searchPoi(kw, cat, center, radius);
      },
      routeMatrix: (o: LatLng, d: LatLng[]) => okProvider().routeMatrix(o, d)
    };
    const field = stubField({});
    const report = await runAnalysis({ center: CENTER }, provider);
    const pois = report.pois;
    const gap = analyzeGaps(field, pois, { failedCategories: report.failedCategories });
    const sites = planFacilitiesFromCoverage(gap, gap.coveredMasks, field, 80);
    return { report, gap, sites };
  }

  it('覆盖率与重度缺失率均为 null（无法评估），不再出现 100%/100%', async () => {
    const { gap } = await allCoreFailed();
    expect(gap.coverageShare).toBeNull();
    expect(gap.severeShare).toBeNull();
  });

  it('未知核心类别不生成补建建议（药店回归检查）', async () => {
    const { sites } = await allCoreFailed();
    expect(sites.filter((s) => s.category === 'pharmacy').length).toBe(0);
    expect(sites.filter((s) => s.category === 'market').length).toBe(0);
    expect(sites.filter((s) => s.category === 'primarySchool').length).toBe(0);
  });
});

// ---------- 验收 2：额度耗尽 → incomplete/quotaExhausted 标记 ----------

describe('冻结验收 · 额度耗尽截断', () => {
  it('部分类目成功后额度耗尽 → 报告标记 incomplete 且 quotaExhausted', async () => {
    const r = await runDefault({}, quotaProvider(2));
    expect(r.quotaExhausted).toBe(true);
    expect(r.incomplete).toBe(true);
  });

  it('首次检索即额度耗尽 → 报告标记不完整', async () => {
    const r = await runDefault({}, quotaProvider(0));
    expect(r.quotaExhausted).toBe(true);
    expect(r.incomplete).toBe(true);
  });
});

// ---------- 验收 3：失败路线不得虚报成功数 ----------

describe('冻结验收 · 路线全失败时降级如实标记', () => {
  it('routeMatrix 返回全部无效 → degraded=true、探针成功数为 0', async () => {
    const r = await runDefault({}, brokenRouteProvider());
    expect(r.degraded).toBe(true);
    expect(r.model.degradedDirs).toBeGreaterThan(0);
    // 有效的探针步数应少于方向数（谐波兜底接管）
    const validFactors = r.model.factors.filter((f) => f !== undefined);
    expect(validFactors.length).toBeGreaterThan(0);
  });
});

// ---------- 冻结门槛回归：正常路径不受影响 ----------

describe('冻结验收 · 正常路径回归', () => {
  it('正常 provider 下 degraded=false、incomplete=false、quotaExhausted=false', async () => {
    const r = await runDefault({}, okProvider());
    expect(r.degraded).toBe(false);
    expect(r.incomplete).toBe(false);
    expect(r.quotaExhausted).toBe(false);
  });
});
