import { beforeEach, describe, expect, it, vi } from 'vitest';

const upstream = vi.hoisted(() => vi.fn());
vi.mock('../server/src/baidu.js', () => ({ callBaidu: upstream, buckets: { place: {}, route: {}, geo: {} } }));
import { BaiduServerProvider } from '../server/src/provider.js';

function pageResult(page: number, count: number, total: number) {
  return { ok: true, httpStatus: 200, tookMs: 0, body: { status: 0, total,
    results: Array.from({ length: count }, (_, i) => ({ uid: `p${page * 20 + i}`, name: `设施${page * 20 + i}`,
      location: { lat: 30.001 + i * 0.0001, lng: 120.001 } })) } };
}

describe('服务端分页、缓存与配额保护（无真实网络）', () => {
  beforeEach(() => { upstream.mockReset(); });

  it('重复分析逐页命中缓存，采集时间不伪装成当前时间且无新增上游请求', async () => {
    upstream.mockImplementation(async (_path, params) => {
      const page = Number(params.page_num);
      return pageResult(page, page ? 5 : 20, 25);
    });
    const count = vi.fn();
    const provider = new BaiduServerProvider('offline-test-placeholder', count);
    const point = { lat: 31.01, lng: 121.01 };
    const first = await provider.searchPoiDetailed('缓存测试', 'pharmacy', point, 2000);
    const second = await provider.searchPoiDetailed('缓存测试', 'pharmacy', point, 2000);
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(count).toHaveBeenCalledTimes(2);
    expect(first.completeness).toMatchObject({ status: 'complete', cacheHit: false, fetchedCount: 25 });
    expect(second.completeness).toMatchObject({ status: 'complete', cacheHit: true, collectedAt: first.completeness.collectedAt });
    expect(upstream.mock.calls.map((args) => args[1].page_num)).toEqual(['0', '1']);
    expect(upstream.mock.calls.every((args) => args[4] === 0)).toBe(true);
  });

  it('第二页配额耗尽后后续关键词及算路均不再发出真实上游调用', async () => {
    upstream.mockImplementation(async (_path, params) => Number(params.page_num) === 0
      ? pageResult(0, 20, 41)
      : { ok: true, httpStatus: 200, tookMs: 0, body: { status: 302, message: '天配额超限' } });
    const provider = new BaiduServerProvider('offline-test-placeholder');
    const point = { lat: 31.02, lng: 121.02 };
    const first = await provider.searchPoiDetailed('额度测试', 'pharmacy', point, 2000);
    const next = await provider.searchPoiDetailed('后续检索测试', 'market', point, 2000);
    await expect(provider.routeMatrix(point, [{ lat: 31.03, lng: 121.03 }])).rejects.toThrow('配额');
    expect(upstream).toHaveBeenCalledTimes(2);
    expect(first.completeness).toMatchObject({ status: 'partial', fetchedCount: 20, quotaExhausted: true });
    expect(next.completeness).toMatchObject({ status: 'failed', quotaExhausted: true });
  });

  it('上游漏给总数时不将已返回列表标成全量', async () => {
    upstream.mockResolvedValue({ ok: true, httpStatus: 200, tookMs: 0, body: { status: 0,
      results: [{ uid: 'without-total', name: '总数缺失测试', location: { lat: 30, lng: 120 } }] } });
    const provider = new BaiduServerProvider('offline-test-placeholder');
    const result = await provider.searchPoiDetailed('总数缺失测试', 'pharmacy', { lat: 31.04, lng: 121.04 }, 2000);
    expect(result.completeness).toMatchObject({ status: 'unknown', reportedTotal: null, fetchedCount: 1 });
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
