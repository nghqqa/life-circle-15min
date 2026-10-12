import {
  CATEGORIES,
  PERSONA_MAP,
  THRESHOLDS,
  buildAnalysisWarnings,
  buildChecklist,
  buildIsochroneModel,
  buildTimeField,
  contourPolylines,
  cumulativeOpportunities,
  dedupePois,
  analyzeGaps,
  computeScore,
  destination,
  interpolationAccuracy,
  interpAngle,
  planFacilitiesFromCoverage,
  sampleBearings,
  type AnalysisResult,
  type CategoryId,
  type ChannelName,
  type LatLng,
  type Poi,
  type PersonaId,
  type RouteProbe
} from './index.js';
import type { CrossingSegment, CrossingStats, PoiSearchCompleteness } from './types.js';
import { createProvenance } from './provenance.js';
import { assessmentUnavailableCategories, poiSearchWarnings, unqueriedPoiSearch, isPoiQuotaError } from './poiSearch.js';

/**
 * 统一分析编排器（同构）：单社区体检的唯一编排实现。
 * 浏览器（React 控制器，服务端不可用时的本地兜底）与服务端（/api/analyze、/api/analyze/stream）
 * 都驱动这份代码——之前「页面路径 vs API 路径」两套编排的数字分歧（覆盖口径 77/B vs 70/C）
 * 即根因于此，现在收敛为一处。
 *
 * 数据获取经 OrchestratorEnv 注入：
 * - 浏览器端 = GatewayChain（服务端代理 → 浏览器直连 → 合成兜底 三级降级 + 熔断 + 缓存）；
 * - 服务端端 = BaiduServerProvider 适配（AK 不出后端，TTL 缓存 + 限流 + 预算闸门）。
 * 页级进度经 onNote/onStep 回调外抛——SSE 路由原样转发给前端 HUD，本地路径直接进 HUD。
 */

export interface WalkingStepGeo {
  text: string;
  path: LatLng[];
}

/** 一次数据获取的环境适配：值 + 通道 + 耗时（与浏览器 ChainResult 同构） */
export interface Orchestrated<T> {
  value: T;
  channel: ChannelName;
  ms: number;
}

export interface OrchestratorEnv {
  routeMatrix(origin: LatLng, dests: LatLng[]): Promise<Orchestrated<(RouteProbe | null)[]>>;
  searchPoiDetailed(
    params: { query: string; location: LatLng; radiusM: number },
    category: CategoryId,
    onPage?: (info: { keyword: string; page: number; fetched: number; budget: number }) => void
  ): Promise<Orchestrated<{ pois: Poi[]; completeness: PoiSearchCompleteness }>>;
  /** 过街扫描用（可选）：无实现时该步如实记「通道不支持」 */
  walkingGeo?(origin: LatLng, dest: LatLng): Promise<Orchestrated<WalkingStepGeo[]>>;
  activeChannel?(): ChannelName | null;
}

export interface OrchestratorSupplement {
  name: string;
  lat: number;
  lng: number;
}

/** 行政边界（服务端经请求体重建，浏览器由本地存储构造）；contains 用偶奇规则射线法 */
export interface OrchestratorBoundary {
  name: string;
  vertexCount: number;
  /** 外环集合（BD-09）；点落入任一外环即在边界内 */
  rings: LatLng[][];
  /** 内洞集合（enclave 不参与统计） */
  holes?: LatLng[][];
  contains(p: LatLng): boolean;
}

export interface OrchestratorOpts {
  center: LatLng;
  centerName: string;
  persona: PersonaId;
  minutes: number;
  crossingsOn: boolean;
  supplements?: OrchestratorSupplement[];
  boundary?: OrchestratorBoundary | null;
  /** WorldPop 兜底回源（服务端直连栅格；浏览器经 /api/popcoverage → 直连公开接口） */
  fetchPopCoverage?: (center: LatLng, ring: LatLng[], radiusM: number) => Promise<AnalysisResult['popCoverage']>;
  /** 演示通道合成数据上下文（浏览器 mock 网关需要；服务端忽略） */
  setMockCtx?: (ctx: { minutes: number; speed: number }) => void;
  onStep?: (idx: number, detail?: string) => void;
  onStepDone?: (idx: number, channel: ChannelName, ms: number) => void;
  onNote?: (s: string) => void;
  /** SSE 客户端断开等场景：步骤/关键词之间检查，true 时中止编排 */
  isCancelled?: () => boolean;
  /** 关键词间限流间隔（毫秒），默认 450；单测传 0 加速 */
  keywordDelayMs?: number;
}

const CHANNEL_LABEL: Record<ChannelName, string> = {
  server: '服务端',
  client: '浏览器端',
  mock: '合成兜底'
};

export function makeProbeDestinations(origin: LatLng, dirs: number, probeM: number): LatLng[] {
  return sampleBearings(dirs).map((b) => destination(origin, b, probeM));
}

/** 射线法单环判定 */
function pointInRing(p: LatLng, ring: LatLng[]): boolean {
  let hit = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const yi = ring[i].lat, xi = ring[i].lng;
    const yj = ring[j].lat, xj = ring[j].lng;
    const intersect = (yi > p.lat) !== (yj > p.lat)
      && p.lng < ((xj - xi) * (p.lat - yi)) / (yj - yi) + xi;
    if (intersect) hit = !hit;
  }
  return hit;
}

/** GeoJSON 多边形集合点包含：落入任一外环且不落入任何内洞 */
export function boundarySetContains(exteriors: LatLng[][], holes: LatLng[][], p: LatLng): boolean {
  if (!exteriors.some((ring) => pointInRing(p, ring))) return false;
  return !holes.some((hole) => pointInRing(p, hole));
}

export async function runOrchestration(env: OrchestratorEnv, opts: OrchestratorOpts): Promise<AnalysisResult> {
  const { center, centerName, minutes } = opts;
  const persona = PERSONA_MAP[opts.persona];
  const stepUsage: AnalysisResult['steps'] = [];
  opts.setMockCtx?.({ minutes, speed: persona.speed });
  const doing = (i: number, d?: string) => opts.onStep?.(i, d);
  const done = (i: number, ch: ChannelName, ms: number) => opts.onStepDone?.(i, ch, ms);
  const note = (s: string) => opts.onNote?.(s);
  const cancelled = () => opts.isCancelled?.() ?? false;
  const ensureLive = () => {
    if (cancelled()) throw new Error('分析已取消');
  };

  // 1) 扇形采样批量算路：先用 2 个探针预检通道健康度——
  //    服务端可用走 48 向批量；否则降为 16 向逐向 SDK 算路（预检探针复用为正北/正南方向）
  doing(1, `路网探针 · 探测半径 ${Math.round(minutes * persona.speed)}m`);
  const probeM = minutes * persona.speed;
  const pre = await env.routeMatrix(center, [
    destination(center, 0, probeM),
    destination(center, 180, probeM)
  ]);
  ensureLive();
  const useServer = pre.channel === 'server';
  const dirs = useServer ? THRESHOLDS.sampleDirs : 16;
  const dests = makeProbeDestinations(center, dirs, probeM);
  const probes: (RouteProbe | null)[] = new Array(dirs).fill(null);
  probes[0] = pre.value[0];
  probes[useServer ? 24 : 8] = pre.value[1];
  const restIdx = probes.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
  const rm = await env.routeMatrix(
    center,
    restIdx.map((i) => dests[i])
  );
  ensureLive();
  restIdx.forEach((idx, k) => {
    probes[idx] = rm.value[k];
  });
  const okProbes = probes.filter((p) => p && p.ok).length;
  stepUsage.push({
    name: '路网采样算路',
    usage: { channel: rm.channel, ms: pre.ms + rm.ms, note: `${okProbes}/${dirs} 向成功` }
  });
  done(1, rm.channel, pre.ms + rm.ms);

  // 2) 等时圈模型 + 时间场 + 等时环
  doing(2, '空间插值生成连续步行时间场');
  const model = buildIsochroneModel(center, probes, {
    dirs,
    minutes,
    speed: persona.speed,
    probeM
  });
  const field = buildTimeField(model);
  const levels = [5, 10, minutes].filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => a - b);
  const rings = levels.map((level) => ({ level, lines: contourPolylines(field, level) }));
  done(2, 'server', 0);

  // 2b) 插值精度自证：8 个抽样点全量算路 vs 模型估计
  let accuracy: AnalysisResult['accuracy'];
  try {
    ensureLive();
    const sb = [15, 60, 105, 150, 195, 240, 285, 330];
    const real = await env.routeMatrix(
      center,
      sb.map((b) => destination(center, b, probeM * 0.6))
    );
    const realProbes = real.value
      .map((p, i) => ({ bearing: sb[i], straightM: probeM * 0.6, distM: p && p.ok ? p.distM : 0 }))
      .filter((p) => p.distM > 0);
    accuracy = interpolationAccuracy(
      center,
      realProbes,
      (theta) => interpAngle(model.factors, dirs, theta),
      persona.speed
    );
    if (accuracy.samples > 0) {
      stepUsage.push({
        name: '插值精度自证',
        usage: { channel: real.channel, ms: real.ms, note: `MAE ${accuracy.maeMinutes} 分钟（${accuracy.maePercent}%）` }
      });
    }
  } catch {
    /* 精度自证失败不影响主流程 */
  }

  // 3) POI 检索
  doing(3, '民生设施分类检索…');
  const search = await searchAllCategories(env, opts, note, stepUsage, center, cancelled);
  const pois = search.pois;
  // №9 人工补录住宅样本并入采样（名称带(补录)后缀；来源标记 client）
  const supps = opts.supplements ?? [];
  for (const s of supps) {
    pois.push({ uid: `supp-${s.lat}-${s.lng}`, name: s.name, lat: s.lat, lng: s.lng, category: 'residential', source: 'client', address: '人工补录' } as Poi);
  }
  if (supps.length) {
    stepUsage.push({ name: '住宅样本补录并入', usage: { channel: 'client', ms: 0, note: `${supps.length} 条人工补录` } });
  }
  // №11 行政边界：范围外样本与设施不参与统计（评分规则本身不变）
  const boundary = opts.boundary ?? null;
  if (boundary) {
    const beforeN = pois.length;
    const kept = pois.filter((p) => boundary.contains(p));
    pois.length = 0;
    pois.push(...kept);
    stepUsage.push({ name: '行政边界筛选', usage: { channel: 'server', ms: 0, note: `边界「${boundary.name}」内样本 ${pois.length}/${beforeN} 条` } });
  }
  done(3, 'server', 0);

  // 4) 盲区识别 + 评分 + 清单 + 累积机会（失败类别按「无法判断」贯通）
  doing(4, '人口加权盲区聚合 · 四维评分');
  const unavailable = assessmentUnavailableCategories(search.failedCategories, search.poiSearch);
  const gap = analyzeGaps(field, unavailable.includes('residential') ? pois.filter((p) => p.category !== 'residential') : pois,
    { failedCategories: unavailable });
  if (unavailable.some((category) => ['market', 'pharmacy', 'primarySchool', 'residential'].includes(category))) {
    gap.coverageShare = null;
    gap.severeShare = null;
    gap.coverageUnavailable = true;
  }
  const score = computeScore(center, pois, gap, { failedCategories: unavailable });
  const checklist = buildChecklist(center, pois, { failedCategories: unavailable });
  const cumulative = cumulativeOpportunities(field, pois, minutes);
  done(4, 'server', 0);

  // 5) 补点规划
  doing(5, '贪心最大覆盖求解补点位置');
  const planSites = planFacilitiesFromCoverage(gap, gap.coveredMasks, field, persona.speed, {
    unknownCategories: unavailable
  });
  done(5, 'server', 0);

  // 6) 过街设施扫描（可选）
  doing(6);
  let crossings: { stats: CrossingStats; segments: CrossingSegment[] } | null = null;
  if (!search.quotaExhausted && opts.crossingsOn) {
    crossings = await scanCrossings(env, center, probeM, stepUsage, note);
  }
  done(6, 'server', 0);

  // 警告：与共享引擎同一生成器，区分「数据缺失」「模型合成」「真实结论」
  const warnings = buildAnalysisWarnings({
    okProbes,
    degradedDirs: model.degradedDirs,
    probes: rm.value,
    probeStraightM: probeM,
    failedCategories: search.failedCategories,
    totalWeight: gap.totalWeight,
    poiOk: search.poiOk
  });
  warnings.push(...poiSearchWarnings(search.poiSearch));
  if (boundary) {
    warnings.unshift(`已导入行政边界「${boundary.name}」（${boundary.vertexCount} 顶点）：仅统计边界内的采样与设施，范围外不参与统计；边界数据来自用户导入，准确性以数据源为准。`);
  }
  if (supps.length) {
    warnings.push(`含人工补录住宅样本 ${supps.length} 条（来源为用户自填，名称带(补录)后缀），已并入住宅采样与覆盖率；真实人口口径未接入（无普查数据），不与样本口径混用。`);
  }
  if (accuracy && accuracy.samples > 0 && accuracy.maePercent >= 30) {
    warnings.push(`插值精度自证误差偏高（MAE ${accuracy.maeMinutes} 分钟 / ${accuracy.maePercent}%，最大 ${accuracy.worstPercent}%）：高误差扇区（多为强阻隔方向）的时间场估计偏差较大，相关圈内结论建议实地核验后再用于决策。`);
  }
  if (search.quotaExhausted) warnings.unshift('已停止后续检索与过街扫描，避免继续消耗配额。');
  const generatedAt = new Date().toISOString();
  const mock = pre.channel === 'mock' || rm.channel === 'mock' || search.usedMock;

  // 人口覆盖率兜底：住宅 POI 口径判「无法评估」时回退 WorldPop 2020 人口栅格口径
  // （等时圈内常住人口 / 理想步行圈 speed×minutes 内常住人口）。
  let popCoverage: AnalysisResult['popCoverage'] = null;
  // 配额耗尽时不再发起任何回源请求（与过街扫描同一节流原则）
  if (gap.coverageUnavailable && !search.quotaExhausted && rings.length && opts.fetchPopCoverage) {
    const outer = rings[rings.length - 1].lines;
    const ring = outer.reduce<LatLng[] | undefined>(
      (best, line) => (line.length > (best?.length ?? 0) ? line : best),
      undefined
    );
    if (ring && ring.length >= 3) {
      try {
        popCoverage = await opts.fetchPopCoverage(center, ring, persona.speed * minutes);
      } catch {
        popCoverage = null;
      }
      if (popCoverage) {
        warnings.push(
          `人口覆盖率改用 WorldPop 2020 年 100m 人口栅格口径估算：等时圈内常住人口约 ${Math.round(popCoverage.popIn).toLocaleString()} / 理想步行圈 ${popCoverage.radiusM}m 内约 ${Math.round(popCoverage.popEval).toLocaleString()}（住宅 POI 口径不可用，两口径不混用，四维评分仍按住宅口径剔除覆盖维度）`
        );
      }
    }
  }

  const counts: Record<string, number> = {};
  for (const p of pois) counts[p.category] = (counts[p.category] ?? 0) + 1;

  return {
    center,
    centerName: centerName || `中心点 ${center.lat.toFixed(5)},${center.lng.toFixed(5)}`,
    persona: opts.persona,
    minutes,
    generatedAt,
    provenance: createProvenance({ generatedAt, poiSearch: search.poiSearch, channels: stepUsage.map((s) => s.usage.channel), mock }),
    model,
    field,
    rings,
    pois,
    gap,
    score,
    checklist,
    planSites,
    cumulative,
    accuracy,
    warnings,
    failedCategories: search.failedCategories,
    poiSearch: search.poiSearch,
    incompleteCategories: unavailable,
    assessmentUnavailableCategories: unavailable,
    incomplete: unavailable.length > 0 || search.quotaExhausted,
    quotaExhausted: search.quotaExhausted,
    crossings: crossings?.stats ?? null,
    crossingSegments: crossings?.segments ?? [],
    popCoverage,
    steps: stepUsage,
    mock,
    // API 投影附加字段：degraded = 探针全失败（与旧 /api/analyze 口径一致）
    degraded: okProbes === 0,
    counts
  };
}

async function searchAllCategories(
  env: OrchestratorEnv,
  opts: OrchestratorOpts,
  onNote: (s: string) => void,
  stepUsage: AnalysisResult['steps'],
  center: LatLng,
  cancelled: () => boolean
): Promise<{ pois: Poi[]; failedCategories: CategoryId[]; poiSearch: PoiSearchCompleteness[]; quotaExhausted: boolean; usedMock: boolean; poiOk: boolean }> {
  const tasks = CATEGORIES.flatMap((c) => c.keywords.map((kw) => ({ cat: c, kw })));
  const out: Poi[] = [];
  const poiSearch: PoiSearchCompleteness[] = [];
  let quotaExhausted = false;
  const failedKw = new Set<string>();
  let done = 0;
  let channel: ChannelName = 'server';
  let usedMock = false;
  let totalMs = 0;

  const t0 = Date.now();
  // 地点检索串行执行（上游并发与配额友好），请求间隔 450ms
  const worker = async () => {
    while (tasks.length) {
      if (cancelled()) throw new Error('分析已取消');
      const t = tasks.shift()!;
      if (quotaExhausted) {
        failedKw.add(t.kw);
        poiSearch.push(unqueriedPoiSearch(t.kw, t.cat.id, channel, 'skipped', true));
        continue;
      }
      try {
        const r = await env.searchPoiDetailed({ query: t.kw, location: center, radiusM: THRESHOLDS.searchRadiusM }, t.cat.id,
          (info) => onNote(`POI 检索 ${done + 1}：${t.kw} 第 ${info.page + 1}/${info.budget} 页 · 已取 ${info.fetched} 条…`));
        for (const p of r.value.pois) out.push({ ...p, category: t.cat.id });
        poiSearch.push(r.value.completeness);
        quotaExhausted ||= r.value.completeness.quotaExhausted;
        if (r.value.completeness.status === 'failed') failedKw.add(t.kw);
        channel = r.channel;
        if (r.channel === 'mock') usedMock = true;
        done++;
        onNote(`POI 检索 ${done}：${t.kw} → ${r.value.pois.length} 条（${CHANNEL_LABEL[r.channel]}）`);
      } catch (error) {
        done++;
        failedKw.add(t.kw);
        quotaExhausted = isPoiQuotaError(error);
        poiSearch.push(unqueriedPoiSearch(t.kw, t.cat.id, channel, 'failed', quotaExhausted));
      }
      await new Promise((res) => setTimeout(res, opts.keywordDelayMs ?? 450));
    }
  };
  await worker();

  totalMs = Date.now() - t0;
  const failedCategories = CATEGORIES.filter((c) => c.keywords.every((kw) => failedKw.has(kw))).map((c) => c.id);
  const poiOk = CATEGORIES.filter((c) => c.scored).some((c) => poiSearch.some((s) => s.category === c.id && s.status === 'complete'));
  stepUsage.push({ name: '设施 POI 检索', usage: { channel, ms: totalMs, note: `共 ${out.length} 条` } });
  return { pois: dedupePois(out), failedCategories, poiSearch, quotaExhausted, usedMock, poiOk };
}

async function scanCrossings(
  env: OrchestratorEnv,
  center: LatLng,
  probeM: number,
  stepUsage: AnalysisResult['steps'],
  onNote?: (s: string) => void
) {
  const t0 = Date.now();
  const stats = { scanned: 0, overpass: 0, underpass: 0, crosswalkHint: 0 };
  const segments: CrossingSegment[] = [];
  if (!env.walkingGeo) {
    stepUsage.push({
      name: '过街设施扫描',
      usage: { channel: env.activeChannel?.() ?? 'server', ms: 0, note: '当前通道不支持步行路线细节，已跳过' }
    });
    onNote?.('过街设施扫描：当前通道不支持步行路线细节，已跳过');
    return { stats, segments };
  }
  for (const b of [30, 90, 150, 210, 270, 330]) {
    const dest = destination(center, b, probeM * 0.6);
    try {
      const r = await env.walkingGeo(center, dest);
      stats.scanned++;
      for (const s of r.value) {
        const text = s.text;
        stats.overpass += (text.match(/天桥/g) ?? []).length;
        stats.underpass += (text.match(/地下通道|地道/g) ?? []).length;
        stats.crosswalkHint += (text.match(/过街|人行横道|路口/g) ?? []).length;
        if (s.path.length >= 2) {
          const kind = /天桥/.test(text) ? 'overpass' : /地下通道|地道/.test(text) ? 'underpass' : /过街|人行横道|路口/.test(text) ? 'crosswalk' : 'walk';
          segments.push({ path: s.path, kind });
        }
      }
    } catch {
      /* 单方向失败忽略 */
    }
  }
  stepUsage.push({
    name: '过街设施扫描',
    usage: { channel: env.activeChannel?.() ?? 'mock', ms: Date.now() - t0, note: `${stats.scanned} 条路段` }
  });
  return { stats, segments };
}
