import { describe, expect, it } from 'vitest';
import {
  runOrchestration,
  boundarySetContains,
  type OrchestratorEnv,
  type Orchestrated
} from '../shared/orchestrator.js';
import { CATEGORIES, DEFAULT_CENTER, type LatLng, type Poi, type RouteProbe } from '../shared/index.js';
import type { PoiSearchCompleteness, PoiSearchResult } from '../shared/types.js';

/** 确定性假环境：算路全成功（等时圈为标准圆），POI 按类别给固定样本 */
function fakeEnv(opts: {
  pois?: Poi[];
  failCategories?: string[];
  truncateResidential?: boolean;
  onPoiPage?: (info: { keyword: string; page: number; fetched: number; budget: number }) => void;
} = {}): OrchestratorEnv {
  const ok = (distM: number): RouteProbe => ({ ok: true, distM });
  const probe = <T>(value: T, ms = 5): Orchestrated<T> => ({ value, channel: 'server', ms });
  const completeness = (cat: string, n: number, status: PoiSearchCompleteness['status'] = 'complete'): PoiSearchCompleteness => ({
    keyword: cat, category: cat as PoiSearchCompleteness['category'], source: 'server',
    status, fetchedCount: n, reportedTotal: n, rawCount: n, pagesFetched: 1, pageSize: 20, pageLimit: 5,
    quotaExhausted: false, collectedAt: new Date().toISOString(), cacheHit: false
  });
  return {
    async routeMatrix(_origin, dests) {
      return probe(dests.map(() => ok(1000)));
    },
    async searchPoiDetailed(params, category, onPage) {
      if (opts.onPoiPage) opts.onPoiPage({ keyword: params.query, page: 0, fetched: 3, budget: 5 });
      if (opts.failCategories?.includes(category)) {
        return probe({ pois: [], completeness: completeness(category, 0, 'failed') });
      }
      if (category === 'residential' && opts.truncateResidential) {
        return probe({
          pois: (opts.pois ?? []).filter((p) => p.category === 'residential'),
          completeness: { ...completeness(category, 100, 'partial'), fetchedCount: 100, reportedTotal: 112 }
        });
      }
      const pois = (opts.pois ?? []).filter((p) => p.category === category);
      return probe({ pois, completeness: completeness(category, pois.length) } as PoiSearchResult);
    }
  };
}

function poi(cat: string, dLat: number): Poi {
  return {
    uid: `${cat}-${dLat}`, name: `${cat}@${dLat}`, lat: DEFAULT_CENTER.lat + dLat, lng: DEFAULT_CENTER.lng,
    category: cat as Poi['category'], source: 'server'
  };
}

const BASE = {
  center: DEFAULT_CENTER,
  centerName: '测试点',
  minutes: 15
} as const;

describe('统一编排器 runOrchestration', () => {
  it('页级进度经 onNote 外抛（含页码与已取条数），步骤回调按序触发', async () => {
    const notes: string[] = [];
    const steps: number[] = [];
    const done: number[] = [];
    const env = fakeEnv({
      pois: [poi('market', 0.002), poi('pharmacy', 0.003), poi('primarySchool', 0.004), poi('residential', 0.001)],
      onPoiPage: (info) => { if (info.keyword === CATEGORIES[0].keywords[0]) notes.push(`第 ${info.page + 1} 页 · 已取 ${info.fetched} 条`); }
    });
    const result = await runOrchestration(env, {
      ...BASE,
      persona: 'adult',
      crossingsOn: false,
      keywordDelayMs: 0,
      onNote: (s) => notes.push(s),
      onStep: (i) => steps.push(i),
      onStepDone: (i) => done.push(i)
    });
    expect(notes.some((s) => s.includes('第 1 页 · 已取 3 条'))).toBe(true);
    expect(steps).toEqual([1, 2, 3, 4, 5, 6]);
    expect(done).toEqual([1, 2, 3, 4, 5, 6]);
    expect(result.score.total).toBeGreaterThan(0);
    // 步骤记录包含 POI 检索与插值自证
    expect(result.steps.map((s) => s.name)).toContain('设施 POI 检索');
  });

  it('人工补录样本并入住宅采样，行政边界剔除范围外样本', async () => {
    const env = fakeEnv({ pois: [poi('residential', 0.02), poi('market', 0.004)] });
    const result = await runOrchestration(env, {
      ...BASE,
      persona: 'adult',
      crossingsOn: false,
      keywordDelayMs: 0,
      supplements: [{ name: '手动小区(补录)', lat: DEFAULT_CENTER.lat + 0.003, lng: DEFAULT_CENTER.lng }],
      boundary: {
        name: '测试边界', vertexCount: 4,
        rings: [[
          { lat: DEFAULT_CENTER.lat + 0.01, lng: DEFAULT_CENTER.lng - 0.01 },
          { lat: DEFAULT_CENTER.lat + 0.01, lng: DEFAULT_CENTER.lng + 0.01 },
          { lat: DEFAULT_CENTER.lat - 0.005, lng: DEFAULT_CENTER.lng + 0.01 },
          { lat: DEFAULT_CENTER.lat - 0.005, lng: DEFAULT_CENTER.lng - 0.01 }
        ]],
        contains: (p) => p.lat <= DEFAULT_CENTER.lat + 0.01 && p.lat >= DEFAULT_CENTER.lat - 0.005
      }
    });
    const names = result.pois.map((p) => p.name);
    expect(names.some((n) => n.includes('补录'))).toBe(true);
    // 0.02°（约 2.2km，超出 15 分钟步行场范围且在边界外）的住宅被边界剔除
    expect(names.filter((n) => n.startsWith('residential@0.02')).length).toBe(0);
    expect(result.warnings!.join('\n')).toContain('行政边界');
    expect(result.warnings!.join('\n')).toContain('人工补录');
  });

  it('住宅检索截断时覆盖判无法评估并经 fetchPopCoverage 兜底，评分剔除覆盖维', async () => {
    const env = fakeEnv({ pois: [poi('residential', 0.001)], truncateResidential: true });
    let popCalled = false;
    const result = await runOrchestration(env, {
      ...BASE,
      persona: 'adult',
      crossingsOn: false,
      keywordDelayMs: 0,
      fetchPopCoverage: async () => {
        popCalled = true;
        return { share: 0.42, popIn: 1000, popEval: 2380, radiusM: 1200, source: 'worldpop-2020' };
      }
    });
    expect(popCalled).toBe(true);
    expect(result.gap.coverageUnavailable).toBe(true);
    expect(result.popCoverage?.share).toBe(0.42);
    expect(result.warnings!.join('\n')).toContain('WorldPop');
    expect(result.score.dims.coverage).toBeNull();
  });

  it('核心三件套检索失败时不再发起 WorldPop 兜底外的设施缺失结论', async () => {
    const env = fakeEnv({ failCategories: ['market', 'pharmacy', 'primarySchool'] });
    const result = await runOrchestration(env, {
      ...BASE,
      persona: 'adult',
      crossingsOn: false,
      keywordDelayMs: 0,
      fetchPopCoverage: async () => null
    });
    expect(result.failedCategories!.sort()).toEqual(['market', 'pharmacy', 'primarySchool'].sort());
    expect(result.incomplete).toBe(true);
    expect(result.warnings!.join('\n')).toContain('未计入评分');
  });
});

describe('boundarySetContains（服务端边界重建）', () => {
  const square: LatLng[] = [
    { lat: 10, lng: 10 }, { lat: 12, lng: 10 }, { lat: 12, lng: 12 }, { lat: 10, lng: 12 }
  ];
  const hole: LatLng[] = [
    { lat: 10.8, lng: 10.8 }, { lat: 11.2, lng: 10.8 }, { lat: 11.2, lng: 11.2 }, { lat: 10.8, lng: 11.2 }
  ];
  it('外环内判真、外环外判假', () => {
    expect(boundarySetContains([square], [], { lat: 11, lng: 11 })).toBe(true);
    expect(boundarySetContains([square], [], { lat: 13, lng: 11 })).toBe(false);
  });
  it('内洞视为边界外（enclave 不参与统计）', () => {
    expect(boundarySetContains([square], [hole], { lat: 11, lng: 11 })).toBe(false);
    expect(boundarySetContains([square], [hole], { lat: 10.4, lng: 11 })).toBe(true);
  });
  it('多外环取并集', () => {
    const other: LatLng[] = [
      { lat: 20, lng: 20 }, { lat: 21, lng: 20 }, { lat: 21, lng: 21 }, { lat: 20, lng: 21 }
    ];
    expect(boundarySetContains([square, other], [], { lat: 20.5, lng: 20.5 })).toBe(true);
  });
});
