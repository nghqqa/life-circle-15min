import { CATEGORY_MAP, CORE_CATEGORIES, THRESHOLDS } from './config.js';
import { localDistM } from './geo.js';
import { latOfRow, lngOfCol } from './timefield.js';
import type { GapAnalysis, LatLng, PlanSite, TimeField } from './types.js';

/** 把一个已采纳的补点写入覆盖掩码副本（交互式工作台）：其服务盘内该类别视为已覆盖 */
export function applySiteCoverage(
  masks: Record<string, Uint8Array>,
  category: string,
  site: LatLng,
  field: TimeField,
  radiusM = THRESHOLDS.coreRadiusM
): void {
  const mask = masks[category];
  if (!mask) return;
  const n = field.n;
  const extentM = (field.latMax - field.center.lat) * 2 * 111320;
  const stepM = extentM / (n - 1);
  const stepLat = stepM / 111320;
  const stepLng = stepM / (111320 * Math.cos((site.lat * Math.PI) / 180));
  const ci = Math.round((field.latMax - site.lat) / stepLat);
  const cj = Math.round((site.lng - field.lngMin) / stepLng);
  const rCells = Math.ceil(radiusM / stepM);
  for (let i = Math.max(0, ci - rCells); i <= Math.min(n - 1, ci + rCells); i++) {
    for (let j = Math.max(0, cj - rCells); j <= Math.min(n - 1, cj + rCells); j++) {
      const d = Math.hypot((ci - i) * stepM, (cj - j) * stepM);
      if (d <= radiusM) mask[i * n + j] = 1;
    }
  }
}

/**
 * 补点选址引擎（贪心最大覆盖）—— 赛题标题里"规划助手"的落点：
 *
 * 1. 候选点位：灰色斑块内缺主导设施的网格质心（抽样去密）；
 * 2. 收益函数：新增 1 个该类设施后，其 coreRadiusM 服务盘内
 *    「原本缺失该类且有权重」的网格权重之和；
 * 3. 每轮贪心选取收益最大的候选 → 虚拟落点 → 更新覆盖 → 迭代至收益枯竭或达到上限；
 * 4. 输出带量化收益的建议（覆盖率提升前后对比），并在地图上做前后模拟。
 */

export function planFacilities(
  gap: GapAnalysis,
  field: TimeField,
  personaSpeed: number,
  opts: { topK?: number; coreRadiusM?: number; unknownCategories?: string[] } = {}
): PlanSite[] {
  return planFacilitiesFromCoverage(gap, gap.coveredMasks, field, personaSpeed, {
    ...opts,
    unknownCategories: opts.unknownCategories ?? gap.unknownCategories
  });
}
export function planFacilitiesFromCoverage(
  gap: GapAnalysis,
  coveredMasks: Record<string, Uint8Array>,
  field: TimeField,
  personaSpeed: number,
  opts: {
    topK?: number; coreRadiusM?: number; unknownCategories?: string[];
    customCandidates?: import('./types.js').CustomCandidate[];
    noGoZones?: import('./types.js').NoGoZone[];
    budget?: import('./types.js').BudgetConstraint;
  } = {}
): PlanSite[] {
  const topK = opts.topK ?? THRESHOLDS.planTopK;
  const R = opts.coreRadiusM ?? THRESHOLDS.coreRadiusM;
  const n = gap.n;
  const stepM = gridExtentM(field) / (n - 1);
  // 检索失败（未知）的类别：掩码不可信（未知 ≠ 缺失），不得生成补建建议
  const unknown = new Set<string>(opts.unknownCategories ?? gap.unknownCategories ?? []);

  // №8 预算约束：最大数量与「总预算 / 单点成本」共同限制输出条数
  let limit = topK;
  const b = opts.budget;
  if (b?.maxSites !== undefined && Number.isFinite(b.maxSites)) limit = Math.min(limit, Math.max(0, Math.floor(b.maxSites)));
  if (b?.totalBudgetWan !== undefined && b?.costPerSiteWan !== undefined && b.costPerSiteWan > 0) {
    limit = Math.min(limit, Math.floor(b.totalBudgetWan / b.costPerSiteWan));
  }

  const cov: Record<string, Uint8Array> = {};
  for (const cat of CORE_CATEGORIES) cov[cat] = Uint8Array.from(coveredMasks[cat]);

  const weight = gap.weightGrid;
  const totalWeight = gap.totalWeight;
  const coveredAt = (k: number) => CORE_CATEGORIES.every((c) => cov[c][k] === 1);
  const catCoverage = (cat: string) => {
    let w = 0;
    for (let k = 0; k < n * n; k++) if (weight[k] > 0 && cov[cat][k] === 1) w += weight[k];
    return totalWeight > 0 ? w / totalWeight : 1;
  };

  // 候选点：所有「有居住权重且缺失任一【已知】核心设施」的格点（含单缺场景），
  // 按步长抽样去密；每个候选对其缺失的每个已知核心类别各生成一条（贪心按收益择优）。
  // 未知类别（检索失败）跳过——掩码不可信，不得据此建议补建。
  const candidates: { k: number; cat: string }[] = [];
  const gridCandidates: { k: number; cat: string }[] = [];
  const stride = Math.max(1, Math.round(R / stepM / 3));
  for (let k = 0; k < n * n; k++) {
    if (weight[k] <= 0) continue;
    if (k % (stride * stride) !== 0) continue; // 稳定抽样去密
    const missingHere = CORE_CATEGORIES.filter((c) => cov[c][k] === 0 && !unknown.has(c));
    if (!missingHere.length) continue;
    const lat = latOfRow(field, Math.floor(k / n));
    const lng = lngOfCol(field, k % n);
    // №7 禁建区：区域内的网格候选直接排除
    if ((opts.noGoZones ?? []).some((z) => localDistM(lat, lng, z.center.lat, z.center.lng) <= z.radiusM)) continue;
    for (const cat of missingHere) gridCandidates.push({ k, cat });
  }
  // №7 自定义候选：手动指定落点（吸附到最近网格），与网格候选同场竞价；
  // 自定义候选排在前面——收益打平时用户显式指定的落点优先
  const customKeys = new Set<string>();
  for (const cc of opts.customCandidates ?? []) {
    if (!CORE_CATEGORIES.includes(cc.category)) continue;
    if ((opts.noGoZones ?? []).some((z) => localDistM(cc.latLng.lat, cc.latLng.lng, z.center.lat, z.center.lng) <= z.radiusM)) continue;
    const k = snapToCell(field, n, cc.latLng);
    const key = `${k}:${cc.category}`;
    if (customKeys.has(key)) continue;
    customKeys.add(key);
    candidates.push({ k, cat: cc.category });
  }
  candidates.push(...gridCandidates);

  const sites: PlanSite[] = [];
  for (let rank = 1; rank <= limit && candidates.length; rank++) {
    let bestIdx = -1;
    let bestGain = 0;
    let bestCovered: number[] = [];
    let bestCat = '';
    for (let ci = 0; ci < candidates.length; ci++) {
      const { k, cat } = candidates[ci];
      if (cov[cat][k] === 1) continue;
      const c = { lat: latOfRow(field, Math.floor(k / n)), lng: lngOfCol(field, k % n) };
      const newly: number[] = [];
      let gain = 0;
      const rangeCells = Math.ceil(R / stepM);
      const ki = Math.floor(k / n);
      const kj = k % n;
      for (let i = Math.max(0, ki - rangeCells); i <= Math.min(n - 1, ki + rangeCells); i++) {
        for (let j = Math.max(0, kj - rangeCells); j <= Math.min(n - 1, kj + rangeCells); j++) {
          const kk = i * n + j;
          if (cov[cat][kk] === 1 || weight[kk] <= 0) continue;
          const d = localDistM(c.lat, c.lng, latOfRow(field, i), lngOfCol(field, j));
          if (d <= R) {
            newly.push(kk);
            gain += weight[kk];
          }
        }
      }
      if (gain > bestGain + 1e-9) {
        bestGain = gain;
        bestIdx = ci;
        bestCovered = newly;
        bestCat = cat;
      }
    }
    if (bestIdx < 0 || bestGain < Math.max(totalWeight * 0.01, 0.5)) break;

    const { k } = candidates[bestIdx];
    const c = { lat: latOfRow(field, Math.floor(k / n)), lng: lngOfCol(field, k % n) };
    const catBeforePct = catCoverage(bestCat);
    for (const kk of bestCovered) cov[bestCat][kk] = 1;
    const catAfterPct = catCoverage(bestCat);

    // 服务半径折算步行分钟（保守取 1.25 绕行系数）
    const DETOUR_ASSUMED = 1.25;
    const estWalkMin = (R * DETOUR_ASSUMED) / personaSpeed;

    // 剔除与已选点过近的候选（<400m）
    const kept: typeof candidates = [];
    for (const cand of candidates) {
      const cl = { lat: latOfRow(field, Math.floor(cand.k / n)), lng: lngOfCol(field, cand.k % n) };
      if (localDistM(cl.lat, cl.lng, c.lat, c.lng) < 400) continue;
      kept.push(cand);
    }
    candidates.length = 0;
    candidates.push(...kept);

    sites.push({
      rank,
      latLng: c,
      category: bestCat as PlanSite['category'],
      coveredCells: bestCovered.length,
      coveredWeight: bestGain,
      beforePct: Math.round(catBeforePct * 1000) / 10,
      afterPct: Math.round(catAfterPct * 1000) / 10,
      estWalkMin: Math.round(estWalkMin * 10) / 10,
      rationale: `${customKeys.has(`${k}:${bestCat}`) ? '自定义候选落点：' : ''}补建${CATEGORY_MAP[bestCat as keyof typeof CATEGORY_MAP].name}后，其 1km 服务盘新覆盖 ${bestCovered.length} 个居住网格，「${CATEGORY_MAP[bestCat as keyof typeof CATEGORY_MAP].name}」居住覆盖率 ${Math.round(catBeforePct * 100)}% → ${Math.round(catAfterPct * 100)}%`
    });
  }
  return sites;
}

/** №7 自定义落点吸附到最近网格单元（误差 ≤ 半格距，rationale 中已标注为自定义候选） */
function snapToCell(field: TimeField, n: number, p: LatLng): number {
  const stepM = gridExtentM(field) / (n - 1);
  const stepLat = stepM / 111320;
  const stepLng = stepM / (111320 * Math.cos((p.lat * Math.PI) / 180));
  const i = Math.max(0, Math.min(n - 1, Math.round((field.latMax - p.lat) / stepLat)));
  const j = Math.max(0, Math.min(n - 1, Math.round((p.lng - field.lngMin) / stepLng)));
  return i * n + j;
}

function gridExtentM(f: TimeField): number {
  return (f.latMax - f.center.lat) * 2 * 111320;
}
