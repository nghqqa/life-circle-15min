import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClientGateway, GatewayChain, ServerGateway, type Gateway, type PoiSearchParams } from '../src/api.js';
import { detailedSearchKey, getCachedSearch, setCachedSearch } from '../src/poiCache.js';
import { searchPoiPages } from '../shared/poiSearch.js';
import type { ChannelName, Poi, PoiSearchResult } from '../shared/types.js';

class MemoryStorage {
  private values = new Map<string, string>();
  get length() { return this.values.size; }
  key(index: number) { return [...this.values.keys()][index] ?? null; }
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
  clear() { this.values.clear(); }
}

const params: PoiSearchParams = { query: '药店', location: { lat: 30, lng: 120 }, radiusM: 2000 };
const NOW = new Date('2026-10-11T03:00:00Z');
const COLLECTED = '2026-10-11T01:00:00.000Z';

function pois(count: number, start = 0, source: ChannelName = 'server'): Poi[] {
  return Array.from({ length: count }, (_, i) => ({ uid: `p${start + i}`, name: `药店${start + i}`,
    category: 'pharmacy', lat: 30 + (start + i) * 0.0001, lng: 120, source }));
}
function rawRows(count: number, start = 0) {
  return pois(count, start).map((p) => ({ uid: p.uid, name: p.name, location: { lat: p.lat, lng: p.lng } }));
}
function response(body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json', ...headers } });
}
function stubGateway(name: ChannelName, search: () => Promise<PoiSearchResult>): Gateway {
  return {
    name, searchPoiDetailed: search, searchPoi: vi.fn(async () => []),
    geocode: vi.fn(async () => params.location), reverseGeocode: vi.fn(async () => '测试'),
    routeMatrix: vi.fn(async () => []), walkingRoute: vi.fn(async () => null), walkingSteps: vi.fn(async () => [])
  };
}
function result(source: ChannelName = 'client') {
  return searchPoiPages({ keyword: params.query, category: 'pharmacy', source,
    fetchPage: async () => ({ pois: pois(1, 100, source), reportedTotal: 1, source, collectedAt: COLLECTED }) });
}
async function finish<T>(pending: Promise<T>): Promise<T> {
  // Only virtual local timers run; no network access is ever permitted by the default fetch stub.
  const settled = pending.then((value) => ({ value }), (error) => ({ error }));
  await vi.runAllTimersAsync();
  const done = await settled;
  if ('error' in done) throw done.error;
  return done.value;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal('localStorage', new MemoryStorage());
  vi.stubGlobal('window', {});
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('test forbids real network'); }));
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('浏览器服务端分页与通道降级', () => {
  it('缺少列表响应不是可信零设施；没有total的空列表也不是完整清单', async () => {
    const fetcher = vi.mocked(fetch);
    fetcher.mockResolvedValueOnce(response({ status: 0, total: 0 }))
      .mockResolvedValueOnce(response({ status: 0, results: [] }))
      .mockResolvedValueOnce(response({ status: 0, total: 0, results: [] }));
    const gateway = new ServerGateway();
    expect((await finish(gateway.searchPoiDetailed(params, 'pharmacy'))).completeness.status).toBe('failed');
    expect((await finish(gateway.searchPoiDetailed(params, 'pharmacy'))).completeness.status).toBe('unknown');
    expect((await finish(gateway.searchPoiDetailed(params, 'pharmacy'))).completeness.status).toBe('complete');
  });

  it('第二页失败保留真实第一页，不通过客户端/合成通道补齐', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(response({ status: 0, total: 25, results: rawRows(20) }))
      .mockRejectedValueOnce(new Error('offline page failure'));
    const client = vi.fn(() => result('client'));
    const mock = vi.fn(() => result('mock'));
    const chain = new GatewayChain([new ServerGateway(), stubGateway('client', client), stubGateway('mock', mock)]);
    const r = await finish(chain.searchPoiDetailed(params, 'pharmacy'));
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(client).not.toHaveBeenCalled(); expect(mock).not.toHaveBeenCalled();
    expect(r.channel).toBe('server');
    expect(r.value.pois).toHaveLength(20);
    expect(r.value.completeness.status).toBe('partial');
  });

  it('配额响应停止本次关键词查询，不消耗备用通道配额', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ status: 302, message: '配额耗尽' }));
    const fallback = vi.fn(() => result('client'));
    const chain = new GatewayChain([new ServerGateway(), stubGateway('client', fallback)]);
    const r = await finish(chain.searchPoiDetailed(params, 'pharmacy'));
    expect(r.value.completeness).toMatchObject({ status: 'failed', quotaExhausted: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(chain.circuitOf('server').isOpen()).toBe(true);
  });

  it('首次普通失败可以整个关键词切换备用通道', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('offline'));
    const fallback = vi.fn(() => result('client'));
    const chain = new GatewayChain([new ServerGateway(), stubGateway('client', fallback)]);
    const r = await finish(chain.searchPoiDetailed(params, 'pharmacy'));
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(r.channel).toBe('client');
    expect(r.value.completeness.source).toBe('client');
    expect(r.value.pois.every((p) => p.source === 'client')).toBe(true);
  });

  it('旧接口抛普通异常也应触发正常降级', async () => {
    const legacy = stubGateway('server', () => result('server'));
    delete legacy.searchPoiDetailed;
    legacy.searchPoi = vi.fn(async () => { throw new Error('legacy offline'); });
    const fallback = vi.fn(() => result('client'));
    const chain = new GatewayChain([legacy, stubGateway('client', fallback)]);
    const r = await finish(chain.searchPoiDetailed(params, 'pharmacy'));
    expect(r.channel).toBe('client');
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(chain.circuitOf('server').fails).toBe(1);
  });

  it('旧接口抛配额异常也应返回停止标记，不能让外层继续消耗', async () => {
    const legacy = stubGateway('server', () => result('server'));
    delete legacy.searchPoiDetailed;
    legacy.searchPoi = vi.fn(async () => { throw new Error('place status 302'); });
    const fallback = vi.fn(() => result('client'));
    const chain = new GatewayChain([legacy, stubGateway('client', fallback)]);
    const r = await finish(chain.searchPoiDetailed(params, 'pharmacy'));
    expect(r.value.completeness.quotaExhausted).toBe(true);
    expect(fallback).not.toHaveBeenCalled();
    expect(chain.circuitOf('server').isOpen()).toBe(true);
  });
});

function installSdk(pageResult: (page: number) => unknown, statuses: number[] = [0]) {
  const calls = { instances: 0, nearby: 0, pages: [] as number[] };
  class LocalSearch {
    private currentPage = 0;
    constructor(_map: unknown, private options: { onSearchComplete: (value: unknown) => void }) { calls.instances++; }
    getStatus() { return statuses[this.currentPage] ?? 0; }
    searchNearby() { calls.nearby++; this.options.onSearchComplete(pageResult(0)); }
    gotoPage(page: number) { calls.pages.push(page); this.currentPage = page; this.options.onSearchComplete(pageResult(page)); }
  }
  Object.assign(window, { __LC_MAP__: {}, BMapGL: { LocalSearch,
    Point: class Point { constructor(public lng: number, public lat: number) {} } } });
  return calls;
}

describe('浏览器 GL SDK 分页契约', () => {
  it('同一检索实例使用gotoPage，不重复查询首页', async () => {
    const calls = installSdk((page) => ({ getCurrentNumPois: () => page ? 2 : 20,
      getNumPois: () => 22, getPageIndex: () => page,
      getPoi: (i: number) => ({ uid: `sdk-${page * 20 + i}`, title: `SDK药店${page * 20 + i}`, point: { lat: 30, lng: 120 } }) }));
    const r = await finish(new ClientGateway().searchPoiDetailed(params, 'pharmacy'));
    expect(calls).toEqual({ instances: 1, nearby: 1, pages: [1] });
    expect(r.completeness).toMatchObject({ status: 'complete', fetchedCount: 22, source: 'client' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('空的SDK响应不能claim完整零结果', async () => {
    installSdk(() => null);
    const r = await finish(new ClientGateway().searchPoiDetailed(params, 'pharmacy'));
    expect(r.completeness.status).toBe('failed');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('SDK无效页数量不能与total=0组合成完整结论', async () => {
    installSdk(() => ({ getCurrentNumPois: () => NaN, getNumPois: () => 0 }));
    const r = await finish(new ClientGateway().searchPoiDetailed(params, 'pharmacy'));
    expect(r.completeness.status).toBe('failed');
  });

  it('SDK第二页配额错误保留第一页且不请求第三页', async () => {
    const calls = installSdk((page) => ({ getCurrentNumPois: () => 20, getNumPois: () => 60,
      getPageIndex: () => page, getPoi: (i: number) => ({ uid: `q-${i}`, title: `配额药店${i}`, point: { lat: 30, lng: 120 } }) }), [0, 302]);
    const r = await finish(new ClientGateway().searchPoiDetailed(params, 'pharmacy'));
    expect(calls.pages).toEqual([1]);
    expect(r.completeness).toMatchObject({ status: 'partial', quotaExhausted: true, fetchedCount: 20 });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('详细检索缓存与项目位置隔离', () => {
  it('重复分析缓存保留代理原始采集时间且零新增请求', async () => {
    vi.mocked(fetch).mockResolvedValue(response({ status: 0, total: 1, results: rawRows(1) }, {
      'X-Data-Collected-At': COLLECTED, 'X-Proxy-Cache': 'HIT'
    }));
    const chain = new GatewayChain([new ServerGateway()]);
    const first = await finish(chain.searchPoiDetailed(params, 'pharmacy'));
    vi.setSystemTime(new Date(NOW.getTime() + 60_000));
    const second = await finish(chain.searchPoiDetailed(params, 'pharmacy'));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first.value.completeness.collectedAt).toBe(COLLECTED);
    expect(second.value.completeness).toMatchObject({ collectedAt: COLLECTED, cacheHit: true });
  });

  it('微移中心点、不同类别、半径或通道组合都不会读取另一个项目缓存', async () => {
    const makeKey = (p = params, cat: 'pharmacy' | 'market' = 'pharmacy', channels: ChannelName[] = ['server']) =>
      detailedSearchKey(p.query, p.location, p.radiusM, cat, channels);
    const cachedResult = await result('server');
    setCachedSearch(makeKey(), cachedResult);
    expect(getCachedSearch(makeKey())).not.toBeNull();
    expect(getCachedSearch(makeKey({ ...params, location: { lat: 30.00001, lng: 120 } }))).toBeNull();
    expect(getCachedSearch(makeKey(params, 'market'))).toBeNull();
    expect(getCachedSearch(makeKey({ ...params, radiusM: 1000 }))).toBeNull();
    expect(getCachedSearch(makeKey(params, 'pharmacy', ['client']))).toBeNull();
    expect(getCachedSearch(makeKey(params, 'pharmacy', ['server', 'client']))).toBeNull();
  });

  it('不缓存部分结果或合成数据；旧采集时间不能通过重新写入续期', async () => {
    const key = detailedSearchKey(params.query, params.location, params.radiusM, 'pharmacy', ['server']);
    const partial = await result('server');
    partial.completeness.status = 'partial';
    setCachedSearch(key, partial);
    expect(getCachedSearch(key)).toBeNull();
    setCachedSearch(key, await result('mock'));
    expect(getCachedSearch(key)).toBeNull();
    const stale = await result('server');
    stale.completeness.collectedAt = new Date(NOW.getTime() - 7 * 3600_000).toISOString();
    setCachedSearch(key, stale);
    expect(getCachedSearch(key)).toBeNull();
  });
});
