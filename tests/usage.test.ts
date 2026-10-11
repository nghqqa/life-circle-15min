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
