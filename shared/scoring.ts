import { CATEGORIES, CATEGORY_MAP, GRADE_THRESHOLDS } from './config.js';
import { nearestPoiM } from './poi.js';
import type { GapAnalysis, ScoreDimDetail, ScoreResult, LatLng, Poi } from './types.js';

/** 临近度阶梯衰减：直线距离 → 0-1 得分 */
function proximityFromDistance(d: number | null): number {
  if (d == null) return 0;
  if (d <= 200) return 1;
  if (d <= 500) return 0.85;
  if (d <= 800) return 0.7;
  if (d <= 1200) return 0.5;
  if (d <= 2000) return 0.3;
  if (d <= 3000) return 0.15;
  return 0;
}

export function computeScore(center: LatLng, pois: Poi[], gap: GapAnalysis): ScoreResult {
  const byCat: Record<string, Poi[]> = {};
  for (const p of pois) (byCat[p.category] ??= []).push(p);

  const scored = CATEGORIES.filter((c) => c.scored);
  const details: ScoreDimDetail[] = scored.map((c) => {
    const list = byCat[c.id] ?? [];
    const nearest = nearestPoiM(center, list);
    return {
      category: c.id,
      name: c.name,
      count: list.length,
      ideal: c.ideal,
      completeness: c.ideal > 0 ? Math.min(1, list.length / c.ideal) : 1,
      nearestM: nearest ? Math.round(nearest.distM) : null,
      proximity: proximityFromDistance(nearest ? nearest.distM : null)
    };
  });

  const wSum = scored.reduce((a, c) => a + c.weight, 0);
  const completeness = details.reduce((a, d) => a + d.completeness * CATEGORY_MAP[d.category].weight, 0) / wSum;
  const proximity = details.reduce((a, d) => a + d.proximity * CATEGORY_MAP[d.category].weight, 0) / wSum;
  const coverage = gap.totalWeight > 0 ? gap.coverageShare : 0;

  // 多样性：香农熵（对类别数量分布）
  const counts = details.map((d) => d.count);
  const countTotal = counts.reduce((a, b) => a + b, 0);
  let diversity = 0;
  if (countTotal > 0) {
    let h = 0;
    for (const c of counts) {
      if (c <= 0) continue;
      const p = c / countTotal;
      h -= p * Math.log(p);
    }
    diversity = h / Math.log(counts.length);
  }

  const totalScore =
    completeness * 0.3 + proximity * 0.35 + coverage * 0.2 + diversity * 0.15;
  const total = Math.round(totalScore * 100);
  const grade =
    total >= GRADE_THRESHOLDS.A ? 'A' : total >= GRADE_THRESHOLDS.B ? 'B' : total >= GRADE_THRESHOLDS.C ? 'C' : total >= GRADE_THRESHOLDS.D ? 'D' : 'E';

  const zeroCats = details.filter((d) => d.count === 0).map((d) => d.name);
  const weak = [...details].sort((a, b) => a.completeness * CATEGORY_MAP[a.category].weight - b.completeness * CATEGORY_MAP[b.category].weight)[0];
  const summaryParts: string[] = [];
  if (zeroCats.length) summaryParts.push(`圈内完全没有：${zeroCats.join('、')}`);
  if (gap.patches.length) {
    const top = gap.patches[0];
    summaryParts.push(
      `最大灰色区域位于${bearingName(center, top.centroid)}方向，覆盖约 ${(top.weightShare * 100).toFixed(0)}% 居住权重，主要缺${CATEGORY_MAP[top.dominant].name}`
    );
  }
  if (gap.severeShare > 0.05) summaryParts.push(`重度缺失（三类全无）居住权重占 ${(gap.severeShare * 100).toFixed(0)}%`);
  if (!summaryParts.length) summaryParts.push('各类设施齐备，暂无明显服务盲区');
  summaryParts.unshift(`最薄弱维度：${weak ? CATEGORY_MAP[weak.category].name + '（完整度 ' + Math.round(weak.completeness * 100) + '%）' : '—'}`);

  return { total, grade, dims: { completeness, proximity, coverage, diversity }, details, summary: summaryParts.join('；') + '。' };
}

function bearingName(from: LatLng, to: LatLng): string {
  const dLat = to.lat - from.lat;
  const dLng = to.lng - from.lng;
  const angle = (Math.atan2(dLng, dLat) * 180) / Math.PI;
  const a = (angle + 360) % 360;
  if (a < 22.5 || a >= 337.5) return '正北';
  if (a < 67.5) return '东北';
  if (a < 112.5) return '正东';
  if (a < 157.5) return '东南';
  if (a < 202.5) return '正南';
  if (a < 247.5) return '西南';
  if (a < 292.5) return '正西';
  return '西北';
}
