import { Router, type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import type { ServerConfig } from './config.js';
import { TtlCache } from './cache.js';
import { buckets, callBaidu } from './baidu.js';

/**
 * 百度 Web API 代理：
 * - AK 只存在于服务端；前端仅访问 /api/baidu/*；
 * - 全量 TTL 缓存（算路 24h / POI 6h / 地理编码 24h）；
 * - 上游失败统一返回 HTTP 200 + {status:-1}，前端据此做通道降级；
 * - 批量算路按 20 对一份内部分片串行调用并按序合并，规避上游单次上限。
 */

const HOUR = 3600_000;

export function createApiRouter(cfg: ServerConfig): Router {
  const router = Router();
  const caches = {
    route: new TtlCache<any>(24 * HOUR, 5000),
    place: new TtlCache<any>(6 * HOUR, 8000),
    geo: new TtlCache<any>(24 * HOUR, 4000)
  };

  const hasServerAk = () => cfg.akServer.length >= 16;

  router.use((req, res, next) => {
    if (cfg.allowOrigins.length && req.headers.origin) {
      if (!cfg.allowOrigins.includes(req.headers.origin)) {
        res.status(403).json({ status: -1, message: 'Origin 不在允许列表' });
        return;
      }
    }
    if (!hasServerAk()) {
      res.status(200).json({ status: -1, message: '服务端未配置 BAIDU_MAP_AK_SERVER，代理不可用，请使用浏览器通道或演示模式' });
      return;
    }
    next();
  });

  function sendCached(res: Response, cache: TtlCache<any>, key: string, producer: () => Promise<any>) {
    const hit = cache.get(key);
    if (hit) {
      res.set('X-Proxy-Cache', 'HIT');
      res.json(hit);
      return;
    }
    producer().then((result) => {
      const body = result.body;
      if (result.ok && body && body.status === 0) cache.set(key, body);
      res.set('X-Proxy-Cache', 'MISS');
      res.status(200).json(body);
    });
  }

  // ---- 地理编码 ----
  router.get('/geocoding/v3', (req, res) => {
    const address = String(req.query.address ?? '');
    if (!address) {
      res.json({ status: -1, message: '缺少 address' });
      return;
    }
    sendCached(res, caches.geo, `geo:${address}`, () =>
      callBaidu('/geocoding/v3/', { address }, buckets.geo, cfg.akServer)
    );
  });

  router.get('/reverse_geocoding/v3', (req, res) => {
    const location = String(req.query.location ?? '');
    if (!location) {
      res.json({ status: -1, message: '缺少 location' });
      return;
    }
    sendCached(res, caches.geo, `rev:${location}`, () =>
      callBaidu('/reverse_geocoding/v3/', { location }, buckets.geo, cfg.akServer)
    );
  });

  // ---- POI 检索（圆形区域）----
  router.get('/place/v2/search', (req, res) => {
    const query = String(req.query.query ?? '');
    const location = String(req.query.location ?? '');
    let radius = Number(req.query.radius ?? 2000);
    const page = Number(req.query.page_num ?? 0);
    if (!query || !location) {
      res.json({ status: -1, message: '缺少 query/location' });
      return;
    }
    radius = Math.min(3000, Math.max(100, radius));
    const params: Record<string, string> = {
      query,
      location,
      radius: String(radius),
      radius_limit: 'true',
      scope: '2',
      page_size: '20',
      page_num: String(Math.min(4, Math.max(0, page)))
    };
    const key = `place:${createHash('sha1').update(JSON.stringify(params)).digest('hex')}`;
    sendCached(res, caches.place, key, () => callBaidu('/place/v2/search', params, buckets.place, cfg.akServer));
  });

  // ---- 批量步行算路：GET origins=lat,lng & destinations=lat,lng|lat,lng|... ----
  router.get('/routematrix/v2/walking', async (req, res) => {
    const origins = String(req.query.origins ?? '');
    const destinations = String(req.query.destinations ?? '');
    if (!origins || !destinations) {
      res.json({ status: -1, message: '缺少 origins/destinations' });
      return;
    }
    const destList = destinations.split('|').filter(Boolean);
    const chunkSize = 20;
    const chunks: string[][] = [];
    for (let i = 0; i < destList.length; i += chunkSize) chunks.push(destList.slice(i, i + chunkSize));

    const cacheKeys = chunks.map((c) => `rt:${origins}:${c.join(';')}`);
    const cached = cacheKeys.map((k) => caches.route.get(k));
    if (cached.every((c) => c !== undefined)) {
      res.set('X-Proxy-Cache', 'HIT');
      res.json({ status: 0, result: cached.flatMap((c) => (c as any).result ?? []) });
      return;
    }

    const results: any[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const producer = () =>
        callBaidu(
          '/routematrix/v2/walking',
          { origins, destinations: chunks[i].join('|') },
          buckets.route,
          cfg.akServer
        );
      const key = cacheKeys[i];
      const hit = cached[i];
      let body: any;
      if (hit) {
        body = hit;
      } else {
        const result = await producer();
        body = result.body;
        if (result.ok && body && body.status === 0) caches.route.set(key, body);
      }
      if (!body || body.status !== 0) {
        res.set('X-Proxy-Cache', 'MISS');
        res.status(200).json({ status: body?.status ?? -1, message: body?.message ?? '批量算路失败' });
        return;
      }
      results.push(...(body.result ?? []));
    }
    res.set('X-Proxy-Cache', 'MISS');
    res.json({ status: 0, result: results });
  });

  // ---- 单路径步行规划（用于过街设施扫描等）----
  router.get('/direction/v2/walking', (req, res) => {
    const origin = String(req.query.origin ?? '');
    const destination = String(req.query.destination ?? '');
    if (!origin || !destination) {
      res.json({ status: -1, message: '缺少 origin/destination' });
      return;
    }
    const key = `dir:${origin}:${destination}`;
    sendCached(res, caches.route, key, () =>
      callBaidu('/direction/v2/walking', { origin, destination }, buckets.route, cfg.akServer)
    );
  });

  router.get('/stats', (_req, res) => {
    res.json({
      status: 0,
      caches: {
        route: caches.route.stats(),
        place: caches.place.stats(),
        geo: caches.geo.stats()
      }
    });
  });

  return router;
}
