import { CATEGORIES, PERSONA_MAP, THRESHOLDS } from './config.js';
import { buildChecklist } from './checklist.js';
import { buildIsochroneModel, sampleBearings } from './isochrone.js';
import { buildTimeField, contourPolylines, simplifyLine, sampleTimeNearest } from './timefield.js';
import { analyzeGaps } from './gap.js';
import { computeScore } from './scoring.js';
import { dedupePois } from './poi.js';
import { planFacilitiesFromCoverage } from './planner.js';
import { cumulativeOpportunities, interpolationAccuracy } from './cumulative.js';
import { destination, interpAngle } from './geo.js';
import type {
  CategoryId,
  LatLng,
  PersonaId,
  Poi,
  RouteProbe
} from './types.js';

/**
 * 可共享的分析编排引擎：给定一个数据提供者（浏览器通道 / 服务端通道 / 测试桩），
 * 执行一次完整体检并输出可序列化的报告。Web 端与 API 端共用同一套流程语义。
 */

export interface AnalysisProvider {
  geocode(address: string): Promise<LatLng>;
  reverseGeocode(p: LatLng): Promise<string>;
  searchPoi(keyword: string, category: CategoryId, center: LatLng, radiusM: number): Promise<Poi[]>;
  routeMatrix(origin: LatLng, dests: LatLng[]): Promise<(RouteProbe | null)[]>;
}

export interface AnalyzeParams {
  /** 二选一：直接给中心点，或给地址由地理编码解析 */
  center?: LatLng;
  address?: string;
  persona?: PersonaId;
  minutes?: number;
  /** 检索半径（米），默认 2000 */
  searchRadiusM?: number;
}

export interface AnalysisStep {
  name: string;
  ms: number;
  note?: string;
  ok: boolean;
}

export interface RingLine {
  level: number;
  lines: LatLng[][];
}

export interface PatchSummary {
  id: number;
  centroid: LatLng;
  weightShare: number;
  missingCats: string[];
  dominant: string;
  maxNearestM: number;
  severity: 'severe' | 'moderate';
  outline: LatLng[][];
}

export interface AnalysisReport {
  center: LatLng;
  centerName: string;
  persona: PersonaId;
  minutes: number;
  generatedAt: string;
  degraded: boolean;
  model: {
    dirs: number;
    probeM: number;
    factors: number[];
    radiusM: number[];
    degradedDirs: number;
  };
  rings: RingLine[];
  pois: Poi[];
  counts: Record<string, number>;
  score: ReturnType<typeof computeScore>;
  checklist: ReturnType<typeof buildChecklist>;
  gap: {
    blindPoints: number;
    coverageShare: number;
    severeShare: number;
    patches: PatchSummary[];
  };
  planSites: ReturnType<typeof planFacilitiesFromCoverage>;
  /** 累积机会指标（学界标准口径）：圈内可步行抵达的设施总数与类别数 */
  cumulative: ReturnType<typeof cumulativeOpportunities>;
  /** 插值精度自证：抽样真实算路 vs 模型估计的平均绝对误差 */
  accuracy: ReturnType<typeof interpolationAccuracy>;
  steps: AnalysisStep[];
}

export async function runAnalysis(
  params: AnalyzeParams,
  provider: AnalysisProvider,
  onStep?: (s: AnalysisStep) => void
): Promise<AnalysisReport> {
  const steps: AnalysisStep[] = [];
  const step = (name: string, ms: number, ok: boolean, note?: string) => {
    const s = { name, ms, ok, note };
    steps.push(s);
    onStep?.(s);
    return s;
  };

  const personaId = params.persona ?? 'adult';
  const persona = PERSONA_MAP[personaId];
  const minutes = params.minutes ?? 15;
  const searchRadiusM = params.searchRadiusM ?? THRESHOLDS.searchRadiusM;

  // 1) 中心定位
  let t0 = Date.now();
  let center = params.center;
  let centerName = '';
  if (!center) {
    if (!params.address) throw new Error('需要提供 center 或 address');
    const loc = await provider.geocode(params.address);
    center = loc;
    centerName = params.address;
  }
  if (!centerName) {
    try {
      centerName = await provider.reverseGeocode(center);
    } catch {
      centerName = `中心点 ${center.lat.toFixed(5)},${center.lng.toFixed(5)}`;
    }
  }
  step('中心定位', Date.now() - t0, true, centerName);

  // 2) 扇形采样（2 探针预检决定方向数：服务端健康→48 向，否则 16 向）
  //    上游失败不中断：异常方向记为 null，由等时圈模型的谐波系数兜底
  t0 = Date.now();
  const probeM = minutes * persona.speed;
  let pre: (RouteProbe | null)[] = [null, null];
  try {
    pre = await provider.routeMatrix(center, [
      destination(center, 0, probeM),
      destination(center, 180, probeM)
    ]);
  } catch {
    pre = [null, null];
  }
  const serverHealthy = pre.filter(Boolean).length === 2;
  const dirs = serverHealthy ? THRESHOLDS.sampleDirs : 16;
  const dests = sampleBearings(dirs).map((b) => destination(center, b, probeM));
  const probes: (RouteProbe | null)[] = new Array(dirs).fill(null);
  probes[0] = pre[0];
  probes[serverHealthy ? 24 : 8] = pre[1];
  const restIdx = probes.map((v, i) => (v === null ? i : -1)).filter((i) => i >= 0);
  let rest: (RouteProbe | null)[] = restIdx.map(() => null);
  try {
    rest = await provider.routeMatrix(
      center,
      restIdx.map((i) => dests[i])
    );
  } catch {
    rest = restIdx.map(() => null);
  }
  restIdx.forEach((idx, k) => {
    probes[idx] = rest[k] ?? null;
  });
  const okProbes = probes.filter(Boolean).length;
  step('路网采样算路', Date.now() - t0, okProbes > 0, `${okProbes}/${dirs} 向成功`);

  // 3) 时间场与等时环
  t0 = Date.now();
  const model = buildIsochroneModel(center, probes, { dirs, minutes, speed: persona.speed, probeM });
  const field = buildTimeField(model);
  const levels = [...new Set([5, 10, minutes])].sort((a, b) => a - b);
  const rings = levels.map((level) => ({
    level,
    lines: contourPolylines(field, level).map((line) => simplifyLine(line, 15))
  }));
  step('时间场与等时环', Date.now() - t0, true, `${rings.length} 层等时环`);

  // 3b) 插值精度自证：8 个抽样点全量算路 vs 模型估计 → MAE
  t0 = Date.now();
  const sampleB = [15, 60, 105, 150, 195, 240, 285, 330];
  let accuracy: AnalysisReport['accuracy'] = {
    samples: 0, maeMinutes: 0, maePercent: 0, worstPercent: 0, details: []
  };
  try {
    const real = await provider.routeMatrix(
      center,
      sampleB.map((b) => destination(center, b, probeM * 0.6))
    );
    const realProbes = real
      .map((p, i) => ({
        bearing: sampleB[i],
        straightM: probeM * 0.6,
        distM: p && p.ok ? p.distM : 0
      }))
      .filter((p) => p.distM > 0);
    accuracy = interpolationAccuracy(
      center,
      realProbes,
      (theta) => interpAngle(model.factors, dirs, theta),
      persona.speed
    );
  } catch {
    /* 精度自证失败不影响主流程 */
  }
  step('插值精度自证', Date.now() - t0, accuracy.samples > 0,
    accuracy.samples ? `抽样 ${accuracy.samples} 点 · MAE ${accuracy.maeMinutes} 分钟（${accuracy.maePercent}%）` : '未执行');

  // 4) POI 检索（串行，尊重上游并发限制）
  t0 = Date.now();
  const pois: Poi[] = [];
  const tasks = CATEGORIES.flatMap((c) => c.keywords.map((kw) => ({ cat: c, kw })));
  const perKw: Record<string, number> = {};
  for (const t of tasks) {
    try {
      const found = await provider.searchPoi(t.kw, t.cat.id, center, searchRadiusM);
      pois.push(...found);
      perKw[t.kw] = found.length;
    } catch {
      perKw[t.kw] = 0;
    }
  }
  const cleaned = dedupePois(pois);
  const poiOk = Object.values(perKw).some((n) => n > 0);
  step('设施 POI 检索', Date.now() - t0, poiOk, `共 ${cleaned.length} 条`);

  // 4b) 累积机会指标（学界标准口径）
  const cumulative = cumulativeOpportunities(field, cleaned, minutes);

  // 5) 盲区 + 评分 + 清单
  t0 = Date.now();
  const gap = analyzeGaps(field, cleaned);
  const score = computeScore(center, cleaned, gap);
  const checklist = buildChecklist(center, cleaned);
  step('盲区识别与评分', Date.now() - t0, true, `总分 ${score.total}（${score.grade}）`);

  // 6) 补点规划
  t0 = Date.now();
  const planSites = planFacilitiesFromCoverage(gap, gap.coveredMasks, field, persona.speed);
  step('补点规划', Date.now() - t0, true, `${planSites.length} 条建议`);

  const counts: Record<string, number> = {};
  for (const p of cleaned) counts[p.category] = (counts[p.category] ?? 0) + 1;

  const degraded = okProbes === 0 && !poiOk;

  return {
    center,
    centerName,
    persona: personaId,
    minutes,
    generatedAt: new Date().toISOString(),
    degraded,
    model: {
      dirs,
      probeM,
      factors: model.factors,
      radiusM: model.radiusM,
      degradedDirs: model.degradedDirs
    },
    rings,
    pois: cleaned,
    counts,
    score,
    checklist,
    gap: {
      blindPoints: gap.blindPoints,
      coverageShare: gap.coverageShare,
      severeShare: gap.severeShare,
      patches: gap.patches.map((p) => ({
        id: p.id,
        centroid: p.centroid,
        weightShare: p.weightShare,
        missingCats: p.missingCats,
        dominant: p.dominant,
        maxNearestM: p.maxNearestM,
        severity: p.severity,
        outline: p.outline
      }))
    },
    planSites,
    cumulative,
    accuracy,
    steps
  };
}
