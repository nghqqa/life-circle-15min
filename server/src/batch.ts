import { dedupePois } from '../../shared/poi.js';
import { localDistM } from '../../shared/geo.js';
import type { LatLng, Poi } from '../../shared/types.js';
import { analyzeWithServerProvider } from './provider.js';
import { buckets, callBaidu } from './baidu.js';
import { TtlCache } from './cache.js';

/**
 * 街道级批量体检：以街道中心为圆心检索住宅小区作为采样点，
 * 逐个执行完整体检（服务端引擎），聚合成街道排名。
 * 任务后台串行执行（受上游 2 QPS 限制），前端轮询进度。
 */

export interface BatchCommunityResult {
  name: string;
  center: LatLng;
  score: number;
  grade: string;
  coverageShare: number;
  blindPoints: number;
  patches: number;
  dominantMissing: string | null;
  planTop: string | null;
  degraded: boolean;
  error?: string;
}

export interface BatchJob {
  id: string;
  status: 'running' | 'done' | 'error';
  createdAt: number;
  centerName: string;
  center: LatLng;
  radiusM: number;
  total: number;
  done: number;
  current: string;
  communities: BatchCommunityResult[];
  summary: {
    avgScore: number;
    gradeDist: Record<string, number>;
    best: BatchCommunityResult | null;
    worst: BatchCommunityResult | null;
  } | null;
  error?: string;
}

const jobs = new Map<string, BatchJob>();

function jobId(): string {
  return `bj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function searchResidentials(ak: string, center: LatLng, radiusM: number): Promise<Poi[]> {
  const cache = new TtlCache<Poi[]>(6 * 3600_000, 500);
  const key = `res:${center.lat.toFixed(4)},${center.lng.toFixed(4)}:${radiusM}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const pois: Poi[] = [];
  let quotaExhausted = false;
  for (let page = 0; page < 4; page++) {
    let rows: Poi[] | null = null;
    // 上游偶发 Internal Service Error：每页最多重试 3 次
    for (let attempt = 0; attempt < 3 && !rows; attempt++) {
      if (attempt > 0) await new Promise((res) => setTimeout(res, 400 * attempt));
      const r = await callBaidu(
        '/place/v2/search',
        {
          query: '小区',
          location: `${center.lat},${center.lng}`,
          radius: String(radiusM),
          radius_limit: 'true',
          scope: '2',
          page_size: '20',
          page_num: String(page)
        },
        buckets.place,
        ak
      );
      if (r.ok && r.body?.status === 0) {
        rows = (r.body.results ?? [])
          .filter((it: any) => it.location)
          .map((it: any) => ({
            uid: String(it.uid ?? it.name),
            name: String(it.name ?? ''),
            lat: it.location.lat,
            lng: it.location.lng,
            category: 'residential' as const,
            address: it.address,
            source: 'server' as const
          }));
      } else if (r.body?.status === 302) {
        quotaExhausted = true;
        break; // 天配额超限：非瞬态，提示用户明日重试
      } else if (r.body?.status !== 1 && r.httpStatus < 500) {
        break; // 其他非瞬态错误不再重试
      }
    }
    if (!rows || rows.length === 0) break;
    pois.push(...rows);
    if (rows.length < 20) break;
  }
  if (!pois.length && quotaExhausted) {
    job.status = 'error';
    job.error = '百度检索当日配额已耗尽（status 302），请明日重试或更换配额更高的 AK';
    return;
  }
  const cleaned = dedupePois(pois);
  cache.set(key, cleaned);
  return cleaned;
}

/** 空间抽稀：保证采样点在片区内分布均匀（按 300m 网格去重），再截断至上限 */
function thinCommunities(pois: Poi[], maxN: number): Poi[] {
  const seen = new Set<string>();
  const thinned: Poi[] = [];
  for (const p of pois) {
    const cell = `${Math.round(p.lat / 0.0027)}:${Math.round(p.lng / 0.0033)}`;
    if (seen.has(cell)) continue;
    seen.add(cell);
    thinned.push(p);
  }
  if (thinned.length <= maxN) return thinned;
  // 按相对中心方位角排序后均匀抽取，保证覆盖各方向
  const center = pois.length ? centroid(thinned) : { lat: 0, lng: 0 };
  const withAngle = thinned
    .map((p) => ({ p, angle: Math.atan2(p.lng - center.lng, p.lat - center.lat) }))
    .sort((a, b) => a.angle - b.angle);
  const step = withAngle.length / maxN;
  const out: Poi[] = [];
  for (let i = 0; i < maxN; i++) out.push(withAngle[Math.floor(i * step)].p);
  return out;
}

function centroid(pois: Poi[]): LatLng {
  const lat = pois.reduce((a, p) => a + p.lat, 0) / pois.length;
  const lng = pois.reduce((a, p) => a + p.lng, 0) / pois.length;
  return { lat, lng };
}

export function startStreetBatch(
  ak: string,
  center: LatLng,
  centerName: string,
  radiusM: number,
  maxCommunities: number
): BatchJob {
  const job: BatchJob = {
    id: jobId(),
    status: 'running',
    createdAt: Date.now(),
    centerName,
    center,
    radiusM,
    total: 0,
    done: 0,
    current: '检索片区内住宅小区…',
    communities: [],
    summary: null
  };
  jobs.set(job.id, job);

  void (async () => {
    try {
      const residentials = await searchResidentials(ak, center, radiusM);
      const samples = thinCommunities(residentials, maxCommunities);
      // 限制相邻采样点过近（<300m）重复
      const filtered: Poi[] = [];
      for (const p of samples) {
        if (filtered.every((q) => localDistM(p.lat, p.lng, q.lat, q.lng) >= 300)) filtered.push(p);
      }
      job.total = filtered.length;
      if (!job.total) {
        job.status = 'error';
        job.error = '片区内未检索到住宅小区，请扩大半径或更换地点';
        return;
      }
      for (const p of filtered) {
        job.current = p.name;
        try {
          const report = await analyzeWithServerProvider(
            { center: { lat: p.lat, lng: p.lng }, persona: 'adult', minutes: 15 },
            ak
          );
          job.communities.push({
            name: report.centerName.includes(',') ? p.name : report.centerName,
            center: report.center,
            score: report.score.total,
            grade: report.score.grade,
            coverageShare: report.gap.coverageShare,
            blindPoints: report.gap.blindPoints,
            patches: report.gap.patches.length,
            dominantMissing: report.gap.patches[0]
              ? String(report.gap.patches[0].dominant)
              : null,
            planTop: report.planSites[0] ? String(report.planSites[0].category) : null,
            degraded: report.degraded
          });
        } catch (err) {
          job.communities.push({
            name: p.name,
            center: { lat: p.lat, lng: p.lng },
            score: -1,
            grade: '-',
            coverageShare: 0,
            blindPoints: 0,
            patches: 0,
            dominantMissing: null,
            planTop: null,
            degraded: true,
            error: String((err as Error).message ?? err)
          });
        }
        job.done++;
      }
      const valid = job.communities.filter((c) => c.score >= 0);
      const sorted = [...valid].sort((a, b) => b.score - a.score);
      const gradeDist: Record<string, number> = {};
      for (const c of valid) gradeDist[c.grade] = (gradeDist[c.grade] ?? 0) + 1;
      job.summary = {
        avgScore: valid.length ? Math.round((valid.reduce((a, c) => a + c.score, 0) / valid.length) * 10) / 10 : 0,
        gradeDist,
        best: sorted[0] ?? null,
        worst: sorted[sorted.length - 1] ?? null
      };
      job.status = 'done';
    } catch (err) {
      job.status = 'error';
      job.error = String((err as Error).message ?? err);
    }
  })();

  return job;
}

export function getJob(id: string): BatchJob | undefined {
  return jobs.get(id);
}

/** 清理超过 2 小时的旧任务 */
export function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 2 * 3600_000) jobs.delete(id);
  }
}
