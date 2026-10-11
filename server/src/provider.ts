import { CATEGORIES } from '../../shared/config.js';
import type { AnalysisProvider, AnalyzeParams, AnalysisReport } from '../../shared/analyze.js';
import { runAnalysis } from '../../shared/analyze.js';
import type { CategoryId, LatLng, Poi, PoiSearchResult, RouteProbe } from '../../shared/types.js';
import { isPoiQuotaError, searchPoiPages, type PoiSearchPage } from '../../shared/poiSearch.js';
import { TtlCache } from './cache.js';
import { countCacheHit, overBudget } from './usage.js';
import { buckets, callBaidu } from './baidu.js';

/**
 * 服务端数据提供者：经 AK 代理直连百度 Web API。
 * 缓存为模块级单例——跨请求复用（同一中心点重复分析直接命中，不再消耗上游配额）；
 * 同 key 并发请求自动合并（in-flight 去重），进一步节省配额。
 */

const placeCache = new TtlCache<any>(6 * 3600_000, 8000);
const geoCache = new TtlCache<any>(24 * 3600_000, 4000);
const routeCache = new TtlCache<any>(24 * 3600_000, 8000);
const inflight = new Map<string, Promise<any>>();

/** 缓存 + in-flight 合并：同 key 的并发请求只发一次上游 */
function withCache<V>(cache: TtlCache<V>, key: string, producer: () => Promise<V>): Promise<V> {
  const hit = cache.get(key);
  if (hit !== undefined) {
    countCacheHit();
    return Promise.resolve(hit);
  }
  const pending = inflight.get(key);
  if (pending) return pending as Promise<V>;
  const promise = producer()
    .then((value) => {
      cache.set(key, value);
      inflight.delete(key);
      return value;
    })
    .catch((err) => {
      inflight.delete(key);
      throw err;
    });
  inflight.set(key, promise);
  return promise;
}

function guessCategory(query: string): CategoryId {
  const hit = CATEGORIES.find((c) => c.keywords.includes(query));
  return (hit?.id ?? 'supermarket') as CategoryId;
}

export class BaiduServerProvider implements AnalysisProvider {
  private quotaError: Error | null = null;
  private budgetError: Error | null = null;
  constructor(
    private ak: string,
    /** 上游调用计数回调（批量任务用于真实请求预算） */
    private onUpstreamCall?: () => void
  ) {}

  private count() {
    this.onUpstreamCall?.();
  }

  /** 一次请求计一次预算；任何配额响应会锁止本次分析的后续上游请求。 */
  private async call(path: string, params: Record<string, string>, bucket: Parameters<typeof callBaidu>[2]) {
    if (this.quotaError) throw this.quotaError;
    if (this.budgetError) throw this.budgetError;
    if (overBudget()) {
      // 本地每日预算触顶：与上游配额走同一条优雅降级路径，但语义明确区分
      this.budgetError = new Error('本地每日预算触顶，已停止发起新的上游请求');
      throw this.budgetError;
    }
    this.count();
    // 重试在各方法显式执行，避免底层隐式重试绕过请求计数。
    const response = await callBaidu(path, params, bucket, this.ak, 0);
    if (isPoiQuotaError({ status: response.body?.status, httpStatus: response.httpStatus,
      message: response.body?.message ?? response.body?.msg })) {
      this.quotaError = new Error(`上游配额或限流：status ${response.body?.status ?? response.httpStatus}`);
      throw this.quotaError;
    }
    return response;
  }

  /** 歧义防护：全国 POI 检索同名设施（geocode 全国模糊匹配可能落到异地同名/相似机构，如
   *  「江西师范大学数字产业学院」不带城市前缀会被解析到北京）。名称强包含才采信。 */
  private async nationalPoiHit(address: string): Promise<{ lat: number; lng: number } | null> {
    const r = await this.call('/place/v2/search', { query: address, region: '全国', page_size: '5', page_num: '0' }, buckets.place);
    if (!r.ok || r.body?.status !== 0) return null;
    const norm = (s: string) => String(s).replace(/[\s（）()\-—_、，,。.·]/g, '');
    const q = norm(address);
    if (!q) return null;
    for (const it of r.body.results ?? []) {
      const name = norm(String(it.name ?? '')).replace(/(省|市|区|县)+$/, '');
      if (name.includes(q) || q.includes(name)) {
        const loc = it.location;
        if (Number.isFinite(loc?.lat) && Number.isFinite(loc?.lng)) {
          return { lat: Number(loc.lat), lng: Number(loc.lng) };
        }
      }
    }
    return null;
  }

  async geocode(address: string): Promise<LatLng> {
    const key = `geo:${address}`;
    const loc = await withCache(geoCache, key, async () => {
      // 街道级地址偶发「无相关结果」：带城市前缀提示提升准确性，失败重试一次
      const cityHint = (address.match(/^(.*?市)/)?.[1] ?? '').trim();
      const once = () =>
        this.call(
          '/geocoding/v3/',
          cityHint ? { address, city: cityHint } : { address },
          buckets.geo
        );
      let r = await once().catch(() => once());
      if (!r.ok || r.body?.status !== 0) r = await once().catch(() => r);
      if (r.ok && r.body?.status === 0 && r.body.result?.location) {
        // 全国同名 POI 命中 → 优先（geocode 的「教育」级结果也可能是异地模糊匹配）
        const poi = await this.nationalPoiHit(address).catch(() => null);
        if (poi) return poi;
        return { lat: r.body.result.location.lat, lng: r.body.result.location.lng };
      }
      // geocode 失败/无结果 → POI 兜底（POI 库常比 geocode 库覆盖更多新建校区）
      const poi = await this.nationalPoiHit(address).catch(() => null);
      if (poi) return poi;
      throw new Error(r.body?.message ?? r.body?.msg ?? `geocode ${r.body?.status}`);
    });
    return loc;
  }

  async reverseGeocode(p: LatLng): Promise<string> {
    const key = `rev:${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
    return withCache(geoCache, key, async () => {
      const r = await this.call(
        '/reverse_geocoding/v3/',
        { location: `${p.lat},${p.lng}` },
        buckets.geo
      );
      const name = r.body?.result?.formatted_address;
      if (!r.ok || r.body?.status !== 0 || !name) throw new Error('reverse failed');
      return String(name);
    });
  }

  async searchPoi(keyword: string, category: CategoryId, center: LatLng, radiusM: number): Promise<Poi[]> {
    const result = await this.searchPoiDetailed(keyword, category, center, radiusM);
    if (result.completeness.status === 'failed') {
      throw new Error(result.completeness.quotaExhausted ? '上游配额耗尽，检索停止' : '设施检索失败');
    }
    return result.pois;
  }

  async searchPoiDetailed(keyword: string, category: CategoryId, center: LatLng, radiusM: number): Promise<PoiSearchResult> {
    return searchPoiPages({
      keyword, category, source: 'server',
      fetchPage: (page, pageSize) => this.searchPoiPage(keyword, category, center, radiusM, page, pageSize)
    });
  }

  private async searchPoiPage(
    keyword: string, category: CategoryId, center: LatLng, radiusM: number, page: number, pageSize: number
  ): Promise<PoiSearchPage> {
    const params = {
      query: keyword,
      location: `${center.lat},${center.lng}`,
      radius: String(Math.min(3000, Math.max(100, radiusM))),
      radius_limit: 'true',
      scope: '2',
      page_size: String(pageSize),
      page_num: String(page)
    };
    const key = `place:v2:${category}:${JSON.stringify(params)}`;
    const cached = placeCache.get(key);
    if (cached !== undefined) return { ...cached, cacheHit: true };
    const data: PoiSearchPage = await withCache(placeCache, key, async () => {
      // 上游偶发 status=1（Internal Service Error）为瞬态错误：重试两次，配额类错误不重试
      let r = await this.call('/place/v2/search', params, buckets.place);
      for (let retry = 0; retry < 2 && this.isTransient(r); retry++) {
        await new Promise((res) => setTimeout(res, 400 * (retry + 1)));
        r = await this.call('/place/v2/search', params, buckets.place);
      }
      if (!r.ok || r.body?.status !== 0) throw new Error(r.body?.message ?? r.body?.msg ?? `place ${r.body?.status}`);
      if (!Array.isArray(r.body.results)) throw new Error('设施检索响应缺少结果列表');
      const cat = category ?? guessCategory(keyword);
      const pois: Poi[] = (r.body.results ?? [])
        .filter((it: any) => it.location)
        .map((it: any) => ({
          uid: String(it.uid ?? `${it.name}-${it.address ?? ''}`),
          name: String(it.name ?? ''),
          lat: it.location.lat,
          lng: it.location.lng,
          category: cat,
          address: it.address,
          source: 'server' as const
        }));
      return {
        pois, reportedTotal: typeof r.body.total === 'number' ? r.body.total : null,
        rawCount: r.body.results.length, collectedAt: new Date().toISOString(), source: 'server' as const
      };
    });
    return { ...data, cacheHit: false };
  }

  async routeMatrix(origin: LatLng, dests: LatLng[]): Promise<(RouteProbe | null)[]> {
    const out: (RouteProbe | null)[] = new Array(dests.length).fill(null);
    const chunkSize = 20;
    for (let i = 0; i < dests.length; i += chunkSize) {
      const slice = dests.slice(i, i + chunkSize);
      const destStr = slice.map((d) => `${d.lat},${d.lng}`).join('|');
      const key = `rt:${origin.lat},${origin.lng}:${destStr}`;
      const probes = await withCache(routeCache, key, async () => {
        let r = await this.call(
          '/routematrix/v2/walking',
          { origins: `${origin.lat},${origin.lng}`, destinations: destStr },
          buckets.route
        );
        if (!r.ok || r.body?.status !== 0) {
          if (this.isTransient(r)) {
            await new Promise((res) => setTimeout(res, 500));
            r = await this.call(
              '/routematrix/v2/walking',
              { origins: `${origin.lat},${origin.lng}`, destinations: destStr },
              buckets.route
            );
          }
        }
        if (!r.ok || r.body?.status !== 0) throw new Error(r.body?.message ?? r.body?.msg ?? `routematrix ${r.body?.status}`);
        return (r.body.result ?? []).map((row: any) => {
          const d = row?.distance?.value;
          return typeof d === 'number' && d > 0 ? { ok: true, distM: d } : { ok: false, distM: 0 };
        });
      });
      slice.forEach((_, k) => {
        out[i + k] = probes[k] ?? null;
      });
    }
    return out;
  }

  /** 瞬态错误判定：百度 status=1（Internal Service Error）或网络/网关层失败；配额与权限类错误不重试 */
  private isTransient(r: { ok: boolean; httpStatus: number; body: any }): boolean {
    if (!r.ok && r.httpStatus >= 500) return true;
    return r.body?.status === 1;
  }
}

export function analyzeWithServerProvider(
  params: AnalyzeParams,
  ak: string,
  onUpstreamCall?: () => void
): Promise<AnalysisReport> {
  return runAnalysis(params, new BaiduServerProvider(ak, onUpstreamCall));
}
