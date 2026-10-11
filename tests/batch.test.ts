import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { runAnalysis, type AnalysisProvider, type AnalysisReport } from '../shared/analyze.js';
import { searchPoiPages } from '../shared/poiSearch.js';
import type { CategoryId, LatLng, Poi } from '../shared/types.js';

const stubs = vi.hoisted(() => ({ upstream: vi.fn(), analyze: vi.fn() }));
vi.mock('../server/src/baidu.js', () => ({ callBaidu: stubs.upstream, buckets: { place: {}, route: {}, geo: {} } }));
vi.mock('../server/src/provider.js', () => ({ analyzeWithServerProvider: stubs.analyze }));
import { cancelJob, startStreetBatch, type BatchJob } from '../server/src/batch.js';

// Exercise the actual batch loop and summaries. Both upstream entry points are stubbed.
const center: LatLng = { lat: 28.46, lng: 117.97 }, sampleCount = 10;
type Mode = 'dense' | 'failed' | 'legacy' | 'empty' | 'homesOnly' | 'quota';
const reports = {} as Record<Mode, AnalysisReport>;
function provider(mode: Mode): AnalysisProvider {
  const poi = (keyword: string, category: CategoryId, i = 0): Poi => ({ uid: `${keyword}-${i}`, name: `${keyword}${i}`,
    category, source: 'server', lat: center.lat + .001 + i * .00001, lng: center.lng + .001 });
  return {
    geocode: async () => center,
    reverseGeocode: async () => '东市街道离线验收社区',
    routeMatrix: async (_origin, destinations) => destinations.map(() => ({ ok: true, distM: 1500 })),
    searchPoi: async (keyword, category) => [poi(keyword, category)],
    ...(mode === 'legacy' ? {} : { searchPoiDetailed: async (keyword: string, category: CategoryId) => {
      if (mode === 'failed' || (mode === 'homesOnly' && category !== 'residential')) throw new Error('受控设施检索失败');
      return searchPoiPages({ keyword, category, source: 'server', fetchPage: async page => {
        if (mode === 'quota') throw Object.assign(new Error('受控配额耗尽'), { status: 302 });
        if (mode === 'empty') return { pois: [], reportedTotal: 0 };
        if (mode === 'dense' && ['supermarket', 'residential'].includes(category)) {
          return { pois: Array.from({ length: 20 }, (_, i) => poi(keyword, category, page * 20 + i)), reportedTotal: 100 };
        }
        return { pois: [poi(keyword, category)], reportedTotal: 1 };
      } });
    } })
  };
}
beforeAll(async () => {
  for (const mode of ['dense', 'failed', 'legacy', 'empty', 'homesOnly', 'quota'] as const) {
    reports[mode] = await runAnalysis({ center }, provider(mode));
  }
});
beforeEach(() => {
  stubs.upstream.mockReset(); stubs.analyze.mockReset();
  stubs.upstream.mockResolvedValue({ ok: true, httpStatus: 200, body: { status: 0, results: Array.from({ length: sampleCount }, (_, i) => ({
    uid: `home-${i}`, name: `采样社区${i}`, location: { lat: center.lat + .004 * i, lng: center.lng }
  })) } });
  stubs.analyze.mockImplementation(async (params: { center: LatLng }, _key: string, onCall?: () => void) => {
    onCall?.();
    return { ...structuredClone(reports.dense), center: params.center, centerName: `东市街道社区${stubs.analyze.mock.calls.length}` };
  });
});
function start() { return startStreetBatch('offline-test-placeholder', center, '城区离线回归', 6500, sampleCount, 'district'); }
async function settled(job: BatchJob) {
  await vi.waitFor(() => expect(job.status).not.toBe('running'), { timeout: 2000, interval: 5 });
  return job;
}

describe('城区批量体检 · 完整性与失败熔断', () => {
  it('连续十个超市／住宅检索截断的社区仍完成排名，未知覆盖保持 null', async () => {
    expect(reports.dense.incomplete).toBe(true);
    expect(reports.dense.quotaExhausted).toBe(false);
    expect(reports.dense.poiSearch.filter(s => s.status === 'truncated').map(s => s.category)).toEqual(['supermarket', 'residential']);
    const job = await settled(start());
    expect(job.status).toBe('done'); expect(job.done).toBe(sampleCount);
    expect(stubs.analyze).toHaveBeenCalledTimes(sampleCount);
    expect(job.consecutiveFailures).toBe(0);
    expect(job.communities.every(c => c.score === reports.dense.score.total && !c.error)).toBe(true);
    expect(job.communities.every(c => c.coverageShare === null && c.coverageUnavailable)).toBe(true);
    expect(job.summary?.avgScore).toBe(reports.dense.score.total);
    expect(job.summary?.streetGroups[0].count).toBe(sampleCount);
  });

  it('可用的截断报告重置失败计数，失败样本不进入均分与街道排名', async () => {
    for (let i = 0; i < 4; i++) stubs.analyze.mockResolvedValueOnce(structuredClone(reports.failed));
    stubs.analyze.mockResolvedValueOnce(structuredClone(reports.dense));
    for (let i = 0; i < 4; i++) stubs.analyze.mockResolvedValueOnce(structuredClone(reports.failed));
    const job = await settled(start());
    expect(job.status).toBe('done'); expect(job.done).toBe(sampleCount);
    expect(job.communities.filter(c => c.score < 0)).toHaveLength(8);
    expect(job.summary?.avgScore).toBe(reports.dense.score.total);
    expect(job.summary?.streetGroups.reduce((n, g) => n + g.count, 0)).toBe(2);
    expect(job.consecutiveFailures).toBe(0);
  });

  it('设施全部失败仍在连续五个后熔断，不继续请求后续社区', async () => {
    stubs.analyze.mockResolvedValue(structuredClone(reports.failed));
    const job = await settled(start());
    expect(job.status).toBe('error'); expect(job.error).toContain('连续 5 个');
    expect(job.done).toBe(5); expect(stubs.analyze).toHaveBeenCalledTimes(5);
    expect(job.communities.every(c => c.score === -1 && c.coverageShare === null)).toBe(true);
    expect(job.summary).toBeNull();
  });

  it('只有住宅检索成功、所有民生设施失败不能当作真实零分社区排名', async () => {
    expect(reports.homesOnly.poiSearch.filter(s => s.status === 'complete').map(s => s.category)).toEqual(['residential']);
    stubs.analyze.mockResolvedValue(structuredClone(reports.homesOnly));
    const job = await settled(start());
    expect(job.status).toBe('error'); expect(job.done).toBe(5);
    expect(job.communities.every(c => c.score === -1)).toBe(true);
    expect(stubs.analyze).toHaveBeenCalledTimes(5);
  });

  it('旧接口估算报告仍可参与排名，不要求不存在的 complete 状态', async () => {
    expect(reports.legacy.poiSearch.every(s => s.legacy && s.status === 'unknown')).toBe(true);
    stubs.analyze.mockResolvedValue(structuredClone(reports.legacy));
    const job = await settled(start());
    expect(job.status).toBe('done'); expect(job.communities.every(c => c.score >= 0 && !c.error)).toBe(true);
  });

  it('完整检索确认的零设施结果保留真实零分，不能误判为上游失败', async () => {
    expect(reports.empty.poiSearch.every(s => s.status === 'complete' && s.fetchedCount === 0)).toBe(true);
    stubs.analyze.mockResolvedValue(structuredClone(reports.empty));
    const job = await settled(start());
    expect(job.status).toBe('done'); expect(job.done).toBe(sampleCount);
    expect(job.communities.every(c => c.score === 0 && !c.error)).toBe(true);
    expect(job.summary?.avgScore).toBe(0);
  });

  it('报告标记配额耗尽时立即中止，保留此前已完成社区', async () => {
    stubs.analyze.mockResolvedValueOnce(structuredClone(reports.dense)).mockResolvedValueOnce(structuredClone(reports.quota));
    const job = await settled(start());
    expect(job.status).toBe('error'); expect(job.error).toContain('配额耗尽');
    expect(job.done).toBe(1); expect(job.communities).toHaveLength(1);
    expect(stubs.analyze).toHaveBeenCalledTimes(2);
  });

  it('抛出配额异常仍立即停止，不消耗下一社区请求', async () => {
    stubs.analyze.mockRejectedValueOnce(new Error('place 302: 配额耗尽'));
    const job = await settled(start());
    expect(job.status).toBe('error'); expect(job.error).toContain('配额耗尽');
    expect(job.done).toBe(0); expect(job.communities).toHaveLength(0);
    expect(stubs.analyze).toHaveBeenCalledTimes(1);
  });

  it('取消任务仍保留已完成结果，并停止后续社区分析', async () => {
    let job: BatchJob;
    stubs.analyze.mockImplementationOnce(async () => {
      cancelJob(job.id);
      return structuredClone(reports.dense);
    });
    job = start(); await settled(job);
    expect(job.status).toBe('cancelled'); expect(job.done).toBe(1);
    expect(job.communities).toHaveLength(1); expect(stubs.analyze).toHaveBeenCalledTimes(1);
  });
});
