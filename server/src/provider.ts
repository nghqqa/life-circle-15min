import { CATEGORIES } from '../../shared/config.js';
import type { AnalysisProvider, AnalyzeParams, AnalysisReport } from '../../shared/analyze.js';
import { runAnalysis } from '../../shared/analyze.js';
import type { CategoryId, LatLng, Poi, RouteProbe } from '../../shared/types.js';
import { TtlCache } from './cache.js';
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
  if (hit !== undefined) return Promise.resolve(hit);
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
  constructor(private ak: string) {}

  async geocode(address: string): Promise<LatLng> {
    const key = `geo:${address}`;
    const loc = await withCache(geoCache, key, async () => {
      // 街道级地址偶发「无相关结果」：带城市前缀提示提升准确性，失败重试一次
      const cityHint = (address.match(/^(.*?市)/)?.[1] ?? '').trim();
      const once = () =>
        callBaidu(
          '/geocoding/v3/',
          cityHint ? { address, city: cityHint } : { address },
          buckets.geo,
          this.ak
        );
      let r = await once().catch(() => once());
      if (!r.ok || r.body?.status !== 0) r = await once().catch(() => r);
      if (!r.ok || r.body?.status !== 0) throw new Error(r.body?.message ?? r.body?.msg ?? `geocode ${r.body?.status}`);
      return { lat: r.body.result.location.lat, lng: r.body.result.location.lng };
    });
    return loc;
  }

  async reverseGeocode(p: LatLng): Promise<string> {
    const key = `rev:${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
    return withCache(geoCache, key, async () => {
      const r = await callBaidu(
        '/reverse_geocoding/v3/',
        { location: `${p.lat},${p.lng}` },
        buckets.geo,
        this.ak
      );
      const name = r.body?.result?.formatted_address;
      if (!r.ok || r.body?.status !== 0 || !name) throw new Error('reverse failed');
      return String(name);
    });
  }

  async searchPoi(keyword: string, category: CategoryId, center: LatLng, radiusM: number): Promise<Poi[]> {
    const params = {
      query: keyword,
      location: `${center.lat},${center.lng}`,
      radius: String(Math.min(3000, Math.max(100, radiusM))),
      radius_limit: 'true',
      scope: '2',
      page_size: '20',
      page_num: '0'
    };
    const key = `place:${JSON.stringify(params)}`;
    return withCache(placeCache, key, async () => {
      // 上游偶发 status=1（Internal Service Error）为瞬态错误：重试两次，配额类错误不重试
      let r = await callBaidu('/place/v2/search', params, buckets.place, this.ak);
      for (let retry = 0; retry < 2 && this.isTransient(r); retry++) {
        await new Promise((res) => setTimeout(res, 400 * (retry + 1)));
        r = await callBaidu('/place/v2/search', params, buckets.place, this.ak);
      }
      if (!r.ok || r.body?.status !== 0) throw new Error(r.body?.message ?? r.body?.msg ?? `place ${r.body?.status}`);
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
      return pois;
    });
  }

  async routeMatrix(origin: LatLng, dests: LatLng[]): Promise<(RouteProbe | null)[]> {
    const out: (RouteProbe | null)[] = new Array(dests.length).fill(null);
    const chunkSize = 20;
    for (let i = 0; i < dests.length; i += chunkSize) {
      const slice = dests.slice(i, i + chunkSize);
      const destStr = slice.map((d) => `${d.lat},${d.lng}`).join('|');
      const key = `rt:${origin.lat},${origin.lng}:${destStr}`;
      const probes = await withCache(routeCache, key, async () => {
        let r = await callBaidu(
          '/routematrix/v2/walking',
          { origins: `${origin.lat},${origin.lng}`, destinations: destStr },
          buckets.route,
          this.ak
        );
        if (!r.ok || r.body?.status !== 0) {
          if (this.isTransient(r)) {
            await new Promise((res) => setTimeout(res, 500));
            r = await callBaidu(
              '/routematrix/v2/walking',
              { origins: `${origin.lat},${origin.lng}`, destinations: destStr },
              buckets.route,
              this.ak
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

export function analyzeWithServerProvider(params: AnalyzeParams, ak: string): Promise<AnalysisReport> {
  return runAnalysis(params, new BaiduServerProvider(ak));
}
