import { CATEGORIES } from '../../shared/config.js';
import type { AnalysisProvider, AnalyzeParams, AnalysisReport } from '../../shared/analyze.js';
import { runAnalysis } from '../../shared/analyze.js';
import type { CategoryId, LatLng, Poi, RouteProbe } from '../../shared/types.js';
import { TtlCache } from './cache.js';
import { buckets, callBaidu } from './baidu.js';

/** 服务端数据提供者：经 AK 代理直连百度 Web API（带缓存与限流），驱动共享分析引擎 */

function guessCategory(query: string): CategoryId {
  const hit = CATEGORIES.find((c) => c.keywords.includes(query));
  return (hit?.id ?? 'supermarket') as CategoryId;
}

export class BaiduServerProvider implements AnalysisProvider {
  private placeCache = new TtlCache<any>(6 * 3600_000, 8000);
  private geoCache = new TtlCache<any>(24 * 3600_000, 4000);
  private routeCache = new TtlCache<any>(24 * 3600_000, 8000);

  constructor(private ak: string) {}

  async geocode(address: string): Promise<LatLng> {
    const key = `geo:${address}`;
    const hit = this.geoCache.get(key);
    if (hit) return hit;
    const r = await callBaidu('/geocoding/v3/', { address }, buckets.geo, this.ak);
    if (!r.ok || r.body?.status !== 0) throw new Error(r.body?.message ?? `geocode ${r.body?.status}`);
    const loc = { lat: r.body.result.location.lat, lng: r.body.result.location.lng };
    this.geoCache.set(key, loc);
    return loc;
  }

  async reverseGeocode(p: LatLng): Promise<string> {
    const key = `rev:${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
    const hit = this.geoCache.get(key);
    if (hit) return hit;
    const r = await callBaidu('/reverse_geocoding/v3/', { location: `${p.lat},${p.lng}` }, buckets.geo, this.ak);
    const name = r.body?.result?.formatted_address;
    if (!r.ok || r.body?.status !== 0 || !name) throw new Error('reverse failed');
    this.geoCache.set(key, String(name));
    return String(name);
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
    const hit = this.placeCache.get(key);
    if (hit) return hit;
    const r = await callBaidu('/place/v2/search', params, buckets.place, this.ak);
    if (!r.ok || r.body?.status !== 0) throw new Error(r.body?.message ?? `place ${r.body?.status}`);
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
    this.placeCache.set(key, pois);
    return pois;
  }

  async routeMatrix(origin: LatLng, dests: LatLng[]): Promise<(RouteProbe | null)[]> {
    const out: (RouteProbe | null)[] = new Array(dests.length).fill(null);
    const chunkSize = 20;
    for (let i = 0; i < dests.length; i += chunkSize) {
      const slice = dests.slice(i, i + chunkSize);
      const destStr = slice.map((d) => `${d.lat},${d.lng}`).join('|');
      const key = `rt:${origin.lat},${origin.lng}:${destStr}`;
      const hit = this.routeCache.get(key);
      if (hit) {
        slice.forEach((_, k) => {
          out[i + k] = hit[k] ?? null;
        });
        continue;
      }
      const r = await callBaidu(
        '/routematrix/v2/walking',
        { origins: `${origin.lat},${origin.lng}`, destinations: destStr },
        buckets.route,
        this.ak
      );
      if (!r.ok || r.body?.status !== 0) throw new Error(r.body?.message ?? `routematrix ${r.body?.status}`);
      const probes: (RouteProbe | null)[] = (r.body.result ?? []).map((row: any) => {
        const d = row?.distance?.value;
        return typeof d === 'number' && d > 0 ? { ok: true, distM: d } : null;
      });
      this.routeCache.set(key, probes);
      slice.forEach((_, k) => {
        out[i + k] = probes[k] ?? null;
      });
    }
    return out;
  }
}

export function analyzeWithServerProvider(params: AnalyzeParams, ak: string): Promise<AnalysisReport> {
  return runAnalysis(params, new BaiduServerProvider(ak));
}
