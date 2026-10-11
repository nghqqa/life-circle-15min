import { dedupePois } from '../../shared/poi.js';
import { localDistM } from '../../shared/geo.js';
import { CATEGORY_MAP } from '../../shared/config.js';
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
  street: string;
  center: LatLng;
  score: number;
  grade: string;
  coverageShare: number | null;
  coverageUnavailable?: boolean;
  blindPoints: number;
  patches: number;
  dominantMissing: string | null;
  planTop: string | null;
  degraded: boolean;
  error?: string;
}

export interface StreetGroup {
  street: string;
  count: number;
  avgScore: number;
  weakCount: number;
  bestName: string | null;
  bestScore: number;
  worstName: string | null;
  worstScore: number;
}

export interface BatchJob {
  id: string;
  status: 'running' | 'done' | 'error' | 'cancelled';
  createdAt: number;
  centerName: string;
  center: LatLng;
  radiusM: number;
  total: number;
  done: number;
  current: string;
  /** 上游请求预算（含重试的粗上界）：社区数 × 40 */
  requestBudget: number;
  requestCount: number;
  consecutiveFailures: number;
  communities: BatchCommunityResult[];
  summary: {
    avgScore: number;
    gradeDist: Record<string, number>;
    best: BatchCommunityResult | null;
    worst: BatchCommunityResult | null;
    /** 公平性视角：最优与最差的小区评分极差（分） */
    scoreGap: number;
    /** 薄弱清单：评分 < 75 或覆盖率 < 80% 的小区 */
    weakList: { name: string; score: number; coverageShare: number | null; dominantMissing: string | null }[];
    /** 城区级试点：按街道分组的聚合排名 */
    streetGroups: StreetGroup[];
  } | null;
  cancelled?: boolean;
  error?: string;
}

const jobs = new Map<string, BatchJob>();

function jobId(): string {
  return `bj_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function searchResidentials(
  ak: string,
  center: LatLng,
  radiusM: number,
  job: BatchJob
): Promise<{ pois: Poi[]; quotaExhausted: boolean }> {
  const cache = new TtlCache<Poi[]>(6 * 3600_000, 500);
  const key = `res:${center.lat.toFixed(4)},${center.lng.toFixed(4)}:${radiusM}`;
  const hit = cache.get(key);
  if (hit) return { pois: hit, quotaExhausted: false };
  const pois: Poi[] = [];
  let quotaExhausted = false;
  for (let page = 0; page < 4; page++) {
    if (job.cancelled) return { pois: [], quotaExhausted: false };
    let rows: Poi[] | null = null;
    // 上游偶发 Internal Service Error：每页最多重试 3 次
    for (let attempt = 0; attempt < 3 && !rows; attempt++) {
      if (attempt > 0) await new Promise((res) => setTimeout(res, 400 * attempt));
      job.requestCount++;
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
    return { pois: [], quotaExhausted: true };
  }
  const cleaned = dedupePois(pois);
  cache.set(key, cleaned);
  return { pois: cleaned, quotaExhausted: !cleaned.length && quotaExhausted };
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

/** 从逆地理编码地址中提取街道名（如「东市街道」） */
export function extractStreet(name: string): string {
  const m = name.match(/([\u4e00-\u9fa5]{2,6}街道)/);
  return m ? m[1] : '其他片区';
}

export function startStreetBatch(
  ak: string,
  center: LatLng,
  centerName: string,
  radiusM: number,
  maxCommunities: number,
  scope: 'street' | 'district' = 'street'
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
    requestBudget: maxCommunities * 40,
    requestCount: 0,
    consecutiveFailures: 0,
    communities: [],
    summary: null
  };
  jobs.set(job.id, job);

  void (async () => {
    try {
      const { pois: residentials, quotaExhausted } = await searchResidentials(ak, center, radiusM, job);
      if (quotaExhausted) {
        job.status = 'error';
        job.error = '百度检索当日配额已耗尽（status 302），请明日重试或更换配额更高的 AK';
        return;
      }
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
        if (job.cancelled) {
          job.status = 'cancelled';
          job.error = '任务已取消';
          return;
        }
        if (job.requestCount > job.requestBudget) {
          job.status = 'error';
          job.error = `已超出请求预算（${job.requestBudget} 次上游调用），任务中止以保护配额`;
          return;
        }
        if (job.consecutiveFailures >= 5) {
          job.status = 'error';
          job.error = '连续 5 个小区分析失败，上游可能不可用，任务中止';
          return;
        }
        job.current = p.name;
        try {
          const report = await analyzeWithServerProvider(
            { center: { lat: p.lat, lng: p.lng }, persona: 'adult', minutes: 15 },
            ak,
            () => {
              job.requestCount++;
            }
          );
          // 额度耗尽的报告：立即终止整个任务（后续小区必然同样失败）
          if (report.quotaExhausted) {
            job.status = 'error';
            job.error = `上游配额耗尽，任务中止于第 ${job.done + 1}/${job.total} 个小区（${p.name}）`;
            return;
          }
          // 部分截断不等于社区分析失败；住宅采样成功也不能代替民生设施检索成功。
          const hasUsableFacilities = report.poiSearch.some((s) =>
            CATEGORY_MAP[s.category].scored && (s.status === 'complete' || s.legacy)
          );
          if (!hasUsableFacilities) throw new Error('数据不完整：该小区设施检索未取得可用类别');
          job.consecutiveFailures = 0;
          job.communities.push({
            name: report.centerName.includes(',') ? p.name : report.centerName,
            street: extractStreet(report.centerName),
            center: report.center,
            score: report.score.total,
            grade: report.score.grade,
            coverageShare: report.gap.coverageShare,
            coverageUnavailable: report.gap.coverageUnavailable,
            blindPoints: report.gap.blindPoints,
            patches: report.gap.patches.length,
            dominantMissing: report.gap.patches[0]
              ? String(report.gap.patches[0].dominant)
              : null,
            planTop: report.planSites[0] ? String(report.planSites[0].category) : null,
            degraded: report.degraded
          });
        } catch (err) {
          const msg = String((err as Error).message ?? err);
          // 额度耗尽：立即中止整个任务（后续小区必然同样失败），不再消耗请求
          if (msg.includes('302') || msg.includes('配额') || msg.includes('限流') || msg.includes('搜索量超限')) {
            job.status = 'error';
            job.error = `上游配额耗尽，任务中止于第 ${job.done + 1}/${job.total} 个小区（${p.name}）：${msg}`;
            return;
          }
          job.consecutiveFailures++;
          job.communities.push({
            name: p.name,
            street: extractStreet(p.name),
            center: { lat: p.lat, lng: p.lng },
            score: -1,
            grade: '-',
            coverageShare: null,
            coverageUnavailable: true,
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
      // 城区级试点：按街道分组聚合（每街道小区数/均分/薄弱数/最优最差）
      const groupMap = new Map<string, BatchCommunityResult[]>();
      for (const c of valid) {
        const list = groupMap.get(c.street) ?? [];
        list.push(c);
        groupMap.set(c.street, list);
      }
      const streetGroups: StreetGroup[] = [...groupMap.entries()]
        .map(([street, list]) => {
          const ss = [...list].sort((a, b) => b.score - a.score);
          const avg = Math.round((list.reduce((a, c) => a + c.score, 0) / list.length) * 10) / 10;
          const weak = list.filter(
            (c) => c.score < 75 || (c.coverageShare != null && c.coverageShare < 0.8)
          ).length;
          return {
            street,
            count: list.length,
            avgScore: avg,
            weakCount: weak,
            bestName: ss[0]?.name ?? null,
            bestScore: ss[0]?.score ?? 0,
            worstName: ss[ss.length - 1]?.name ?? null,
            worstScore: ss[ss.length - 1]?.score ?? 0
          };
        })
        .sort((a, b) => b.avgScore - a.avgScore);
      job.summary = {
        avgScore: valid.length ? Math.round((valid.reduce((a, c) => a + c.score, 0) / valid.length) * 10) / 10 : 0,
        gradeDist,
        best: sorted[0] ?? null,
        worst: sorted[sorted.length - 1] ?? null,
        scoreGap: sorted.length > 1 ? sorted[0].score - sorted[sorted.length - 1].score : 0,
        weakList: valid
          .filter((c) => c.score < 75 || (c.coverageShare != null && c.coverageShare < 0.8))
          .sort((a, b) => a.score - b.score)
          .map((c) => ({
            name: c.name,
            score: c.score,
            coverageShare: c.coverageShare ?? null,
            dominantMissing: c.dominantMissing
          })),
        streetGroups
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

export function cancelJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  job.cancelled = true;
  return true;
}

/** 清理超过 2 小时的旧任务 */
export function sweepJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > 2 * 3600_000) jobs.delete(id);
  }
}
