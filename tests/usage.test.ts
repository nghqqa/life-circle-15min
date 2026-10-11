import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** usage.ts 是模块级单例：每个用例重置模块与时间/环境，保证计数隔离 */
async function fresh() {
  vi.resetModules();
  return await import('../server/src/usage.js');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-12T10:00:00'));
  delete process.env.BAIDU_LOCAL_DAILY_BUDGET;
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.BAIDU_LOCAL_DAILY_BUDGET;
});

describe('调用预算与用量计数', () => {
  it('按服务路径分类计数，重试各计一次，快照含预算与口径说明', async () => {
    const u = await fresh();
    u.countUpstream('/place/v2/search');
    u.countUpstream('/place/v2/search');
    u.countUpstream('/routematrix/v2/walking');
    u.countUpstream('/geocoding/v3/');
    u.countCacheHit();
    const snap = u.usageSnapshot();
    expect(snap.requests).toEqual({ place: 2, route: 1, geo: 1, total: 4 });
    expect(snap.cacheHits).toBe(1);
    expect(snap.dailyBudget).toBe(2000);
    expect(snap.overBudget).toBe(false);
    expect(snap.note).toBe('local-process-counter');
  });

  it('本地预算触顶：total ≥ 预算即 overBudget，默认预算 2000', async () => {
    const u = await fresh();
    process.env.BAIDU_LOCAL_DAILY_BUDGET = '3';
    u.countUpstream('/place/v2/search');
    u.countUpstream('/place/v2/search');
    expect(u.overBudget()).toBe(false);
    u.countUpstream('/place/v2/search');
    expect(u.overBudget()).toBe(true);
    expect(u.usageSnapshot().dailyBudget).toBe(3);
  });

  it('预算为 0 表示不限制', async () => {
    const u = await fresh();
    process.env.BAIDU_LOCAL_DAILY_BUDGET = '0';
    for (let i = 0; i < 10; i++) u.countUpstream('/place/v2/search');
    expect(u.overBudget()).toBe(false);
  });

  it('跨日自动归零', async () => {
    const u = await fresh();
    u.countUpstream('/place/v2/search');
    expect(u.usageSnapshot().requests.total).toBe(1);
    vi.setSystemTime(new Date('2026-10-13T00:00:01'));
    const snap = u.usageSnapshot();
    expect(snap.date).toBe('2026-10-13');
    expect(snap.requests.total).toBe(0);
    expect(snap.cacheHits).toBe(0);
  });
});

describe('№13-F2/F8 审查修复', () => {
  it('callBaidu 预算触顶：代理等所有入口都被拦截且不出网', async () => {
    vi.resetModules();
    process.env.BAIDU_LOCAL_DAILY_BUDGET = '1';
    const { countUpstream } = await import('../server/src/usage.js');
    const { callBaidu, buckets } = await import('../server/src/baidu.js');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    countUpstream('/place/v2/search'); // 用掉预算 1/1
    const r = await callBaidu('/geocoding/v3/', { address: 'x' }, buckets.geo, 'test-ak', 0);
    expect(r.ok).toBe(false);
    expect(r.body.message).toContain('预算触顶');
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it('F8：真实 provider 二次相同检索命中缓存并计入 cacheHits', { timeout: 15000 }, async () => {
    vi.resetModules();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    const { BaiduServerProvider } = await import('../server/src/provider.js');
    const { usageSnapshot } = await import('../server/src/usage.js');
    const hits = [0, 1].map((page) => ({
      ok: true, status: 200,
      json: async () => ({ status: 0, total: 1, results: [{ uid: `u-${page}`, name: `便利店${page}`, location: { lat: 28.51, lng: 118.01 }, address: 'x' }] })
    }));
    let n = 0;
    vi.stubGlobal('fetch', async () => hits[Math.min(n++, 1)]);
    const provider = new BaiduServerProvider('test-ak');
    const loc = { lat: 28.5, lng: 118 };
    const first = await provider.searchPoiDetailed('商超', 'supermarket', loc, 2000);
    const before = usageSnapshot().cacheHits;
    const second = await provider.searchPoiDetailed('商超', 'supermarket', loc, 2000);
    expect(second.completeness.cacheHit).toBe(true);
    expect(usageSnapshot().cacheHits).toBe(before + 1);
    expect(first.pois.length).toBe(second.pois.length);
    vi.unstubAllGlobals();
  });
});
