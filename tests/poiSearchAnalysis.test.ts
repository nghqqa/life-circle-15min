import { describe, expect, it } from 'vitest';
import { runAnalysis, type AnalysisProvider } from '../shared/analyze.js';
import { searchPoiPages } from '../shared/poiSearch.js';
import type { CategoryId, LatLng, PoiSearchResult } from '../shared/types.js';

const CENTER: LatLng = { lat: 30, lng: 120 };

function providerWith(search: (keyword: string, category: CategoryId) => Promise<PoiSearchResult>): AnalysisProvider {
  return {
    geocode: async () => CENTER,
    reverseGeocode: async () => '离线检索完整性测试',
    routeMatrix: async (_origin, destinations) => destinations.map(() => ({ ok: true, distM: 1500 })),
    searchPoi: async () => { throw new Error('详细接口存在时不得退回无完整性接口'); },
    searchPoiDetailed: search
  };
}

function complete(keyword: string, category: CategoryId) {
  return searchPoiPages({ keyword, category, source: 'server', fetchPage: async () => ({
    pois: [{ uid: keyword, name: keyword, category, source: 'server', lat: 30.001, lng: 120.001 }], reportedTotal: 1
  }) });
}

describe('报告中的不完整设施不能被解释为真实缺失', () => {
  it('药店分页失败仍保留POI，但不输出药店缺失或补建结论，完整覆盖率不可评估', async () => {
    const r = await runAnalysis({ center: CENTER }, providerWith(async (keyword, category) => {
      if (category !== 'pharmacy') return complete(keyword, category);
      return searchPoiPages({ keyword, category, source: 'server', fetchPage: async (page) => {
        if (page) throw new Error('page timeout');
        return { pois: Array.from({ length: 20 }, (_, i) => ({
          uid: `药店${i}`, name: `药店${i}`, category, source: 'server', lat: 30 + i * 0.0001, lng: 120
        })), reportedTotal: 35 };
      } });
    }));
    expect(r.pois.filter((p) => p.category === 'pharmacy')).toHaveLength(20);
    expect(r.counts.pharmacy).toBe(20);
    expect(r.incomplete).toBe(true);
    expect(r.assessmentUnavailableCategories).toContain('pharmacy');
    expect(r.gap.coverageShare).toBeNull();
    expect(r.gap.coverageUnavailable).toBe(true);
    expect(r.score.details.find((d) => d.category === 'pharmacy')?.missingData).toBe(true);
    expect(r.checklist.find((item) => item.id === 'pharmacy')?.met).toBeNull();
    expect(r.planSites.some((site) => site.category === 'pharmacy')).toBe(false);
    expect(r.warnings.some((warning) => warning.includes('下界'))).toBe(true);
  });

  it('住宅分页不完整不以部分人口代理算覆盖率，也不推荐规划点', async () => {
    const r = await runAnalysis({ center: CENTER }, providerWith(async (keyword, category) => {
      if (category !== 'residential') return complete(keyword, category);
      return searchPoiPages({ keyword, category, source: 'server', fetchPage: async () => ({
        pois: [{ uid: '住宅', name: '住宅', category, source: 'server', lat: 30.002, lng: 120.002 }]
      }) });
    }));
    expect(r.pois.some((p) => p.category === 'residential')).toBe(true);
    expect(r.assessmentUnavailableCategories).toContain('residential');
    expect(r.gap.coverageShare).toBeNull();
    expect(r.gap.severeShare).toBeNull();
    expect(r.planSites).toEqual([]);
  });

  it('一次配额错误后跳过所有关键词，跳过类别不会被报告为0家', async () => {
    const calls: string[] = [];
    const r = await runAnalysis({ center: CENTER }, providerWith(async (keyword, category) => {
      calls.push(keyword);
      return searchPoiPages({ keyword, category, source: 'server', fetchPage: async () => {
        throw Object.assign(new Error('budget exhausted'), { status: 302 });
      } });
    }));
    expect(calls).toHaveLength(1);
    expect(r.quotaExhausted).toBe(true);
    expect(r.poiSearch[0].status).toBe('failed');
    expect(r.poiSearch.slice(1).every((s) => s.status === 'skipped')).toBe(true);
    expect(r.failedCategories).toContain('pharmacy');
    expect(r.failedCategories).toContain('residential');
    expect(r.checklist.every((item) => item.met === null)).toBe(true);
    expect(r.planSites).toEqual([]);
  });

  it('确切的零结果与正常完整结果均不被误标为调用失败', async () => {
    const r = await runAnalysis({ center: CENTER }, providerWith(async (keyword, category) =>
      searchPoiPages({ keyword, category, source: 'server', fetchPage: async () => ({ pois: [], reportedTotal: 0 }) })
    ));
    expect(r.incomplete).toBe(false);
    expect(r.failedCategories).toEqual([]);
    expect(r.incompleteCategories).toEqual([]);
    expect(r.poiSearch.every((s) => s.status === 'complete')).toBe(true);
    expect(r.checklist.every((item) => item.met === false)).toBe(true);
  });

  it('完整详细数据仍能正常生成评分与来源记录', async () => {
    const r = await runAnalysis({ center: CENTER }, providerWith(complete));
    expect(r.incomplete).toBe(false);
    expect(r.assessmentUnavailableCategories).toEqual([]);
    expect(r.gap.coverageShare).not.toBeNull();
    expect(r.provenance?.channels).toEqual(['server']);
    expect(r.provenance?.poiQueries).toBe(r.poiSearch.length);
  });
});
