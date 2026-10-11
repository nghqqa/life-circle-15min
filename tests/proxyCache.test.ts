import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const upstream = vi.hoisted(() => vi.fn());
vi.mock('../server/src/baidu.js', () => ({ callBaidu: upstream, buckets: { place: {}, route: {}, geo: {} } }));
import { createApiRouter } from '../server/src/routes.js';

const firstTime = '2026-10-11T00:00:00.000Z';
const laterTime = '2026-10-11T01:00:00.000Z';
const success = (body: unknown) => ({ ok: true, httpStatus: 200, body, tookMs: 0 });

/** Only localhost is contacted; every upstream call is replaced by the mock above. */
async function withProxy(run: (base: string) => Promise<void>) {
  const app = express();
  app.use('/api/baidu', createApiRouter({
    port: 0, akBrowser: '', akServer: 'offline-test-placeholder', allowOrigins: [], staticDir: ''
  }));
  let server: Server | undefined;
  try {
    await new Promise<void>((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });
    const address = server!.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}/api/baidu`);
  } finally {
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    }
  }
}

beforeEach(() => {
  upstream.mockReset();
  // Keep sockets and fetch on real timers; change only the clock used by caches/headers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(firstTime));
});
afterEach(() => { vi.useRealTimers(); });

describe('代理缓存响应与原始采集时间（离线上游）', () => {
  it.each([
    ['POI', '/place/v2/search?query=pharmacy&location=28,118&page_num=0', '/place/v2/search'],
    ['地理编码', '/geocoding/v3?address=offline-community', '/geocoding/v3/'],
    ['逆地理编码', '/reverse_geocoding/v3?location=28,118', '/reverse_geocoding/v3/'],
    ['步行路线', '/direction/v2/walking?origin=28,118&destination=28.01,118.01', '/direction/v2/walking']
  ])('%s 重复请求返回原始 body，命中缓存且保持首次采集时刻', async (_name, path, upstreamPath) => {
    const body = { status: 0, result: { marker: 'original-payload' }, total: 1, results: [{ uid: 'p1' }] };
    upstream.mockResolvedValue(success(body));
    await withProxy(async base => {
      const first = await fetch(base + path);
      expect(first.status).toBe(200);
      expect(first.headers.get('X-Proxy-Cache')).toBe('MISS');
      expect(first.headers.get('X-Data-Collected-At')).toBe(firstTime);
      expect(await first.json()).toEqual(body);

      vi.setSystemTime(new Date(laterTime));
      const second = await fetch(base + path);
      expect(second.headers.get('X-Proxy-Cache')).toBe('HIT');
      expect(second.headers.get('X-Data-Collected-At')).toBe(firstTime);
      expect(await second.json()).toEqual(body);
      expect(upstream).toHaveBeenCalledTimes(1);
      expect(upstream.mock.calls[0][0]).toBe(upstreamPath);
    });
  });

  it('上游失败不写入缓存；下一次成功响应使用新的采集时刻', async () => {
    const failure = { status: 302, message: 'offline quota response' };
    const recovered = { status: 0, total: 0, results: [] };
    upstream.mockResolvedValueOnce(success(failure)).mockResolvedValueOnce(success(recovered));
    await withProxy(async base => {
      const path = '/place/v2/search?query=pharmacy&location=28,118';
      const first = await fetch(base + path);
      expect(await first.json()).toEqual(failure);
      vi.setSystemTime(new Date(laterTime));
      const second = await fetch(base + path);
      expect(await second.json()).toEqual(recovered);
      expect(second.headers.get('X-Proxy-Cache')).toBe('MISS');
      expect(second.headers.get('X-Data-Collected-At')).toBe(laterTime);
      expect(upstream).toHaveBeenCalledTimes(2);
    });
  });
});
