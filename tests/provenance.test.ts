import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProvenance } from '../shared/provenance.js';
import type { PoiSearchCompleteness } from '../shared/types.js';

const generatedAt = '2026-10-11T02:00:00.000Z';
function search(overrides: Partial<PoiSearchCompleteness> = {}): PoiSearchCompleteness {
  return {
    keyword: '药店', category: 'pharmacy', status: 'complete', reportedTotal: 1,
    rawCount: 1, fetchedCount: 1, pagesFetched: 1, pageSize: 20, pageLimit: 2,
    quotaExhausted: false, collectedAt: generatedAt, cacheHit: false, source: 'server',
    ...overrides
  };
}

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('报告数据来源记录', () => {
  it.each([{}, undefined])('普通 HTTP 没有 randomUUID 时同一毫秒仍可生成独立报告编号（%s）', (crypto) => {
    vi.stubGlobal('crypto', crypto);
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse(generatedAt));
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.125).mockReturnValueOnce(0.75);
    const input = { generatedAt, channels: ['mock'] as const, mock: true };
    const first = createProvenance({ ...input, channels: [...input.channels] });
    const second = createProvenance({ ...input, channels: [...input.channels] });
    expect(first.reportId).toMatch(/^report_[a-z0-9]+_[a-z0-9]+$/);
    expect(second.reportId).toMatch(/^report_[a-z0-9]+_[a-z0-9]+$/);
    expect(second.reportId).not.toBe(first.reportId);
    expect(first.generatedAt).toBe(generatedAt);
  });

  it('保留最早的原始采集时间，统计缓存，并合并去重通道', () => {
    const oldest = '2026-10-10T08:30:00.000Z';
    const result = createProvenance({
      generatedAt, channels: ['server', 'server', 'mock'], mock: true,
      poiSearch: [
        search({ source: 'client' }),
        search({ collectedAt: oldest, cacheHit: true }),
        search({ status: 'skipped', pagesFetched: 0, collectedAt: '2000-01-01T00:00:00.000Z' }),
        search({ collectedAt: 'not-a-date', source: 'mock' })
      ]
    });
    expect(result).toMatchObject({ generatedAt, poiCollectedAt: oldest, poiCacheHits: 1, poiQueries: 4, mock: true });
    expect(result.channels).toEqual(['server', 'mock', 'client']);
  });

  it('没有实际取得的页面时不把报告生成时间冒充采集时间', () => {
    const result = createProvenance({
      generatedAt, channels: ['server'], mock: false,
      poiSearch: [search({ status: 'failed', pagesFetched: 0 })]
    });
    expect(result.poiCollectedAt).toBeNull();
    expect(result.poiCacheHits).toBe(0);
  });
});
