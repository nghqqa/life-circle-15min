import type { LatLng, Poi, TimeField } from './types.js';
import { sampleTimeNearest } from './timefield.js';

/**
 * 累积机会指标（cumulative opportunity measure）——可达性研究的学界标准口径：
 * 在 t 分钟步行圈内，居民可抵达的设施总数与设施类别数。
 * 与「直线距离计数」不同，这里的可达性以真实路网步行时间场判定。
 */

export interface CumulativeOpportunity {
  /** 圈内可步行抵达的设施总数 */
  total: number;
  /** 按类别的圈内设施计数 */
  byCategory: Record<string, number>;
  /** 覆盖的设施类别数（0-10） */
  categoriesCovered: number;
  /** 圈外最近格点的缺失类别（辅助诊断） */
  missingCategories: string[];
}

export function cumulativeOpportunities(
  field: TimeField,
  pois: Poi[],
  minutes: number
): CumulativeOpportunity {
  const byCategory: Record<string, number> = {};
  let total = 0;
  for (const p of pois) {
    if (p.category === 'residential') continue;
    const t = sampleTimeNearest(field, { lat: p.lat, lng: p.lng });
    if (!isFinite(t) || t > minutes) continue;
    total += 1;
    byCategory[p.category] = (byCategory[p.category] ?? 0) + 1;
  }
  const categoriesCovered = Object.keys(byCategory).length;
  const missingCategories = ['hospital', 'clinic', 'pharmacy', 'market', 'supermarket', 'primarySchool', 'kindergarten', 'elderly', 'busStop', 'park']
    .filter((c) => !byCategory[c]);
  return { total, byCategory, categoriesCovered, missingCategories };
}

/**
 * 插值精度自证：抽样若干真实算路点，对比「模型估计步行时间」与「真实路网步行时间」，
 * 输出平均绝对误差（分钟与百分比）。用于向评审量化扇形插值方法的近似误差。
 * 模型估计口径：直线位移距离 × 绕行系数 f(θ) ÷ 速度——与等时圈模型同构。
 */
export interface AccuracyReport {
  samples: number;
  maeMinutes: number;
  maePercent: number;
  worstPercent: number;
  details: { bearing: number; straightM: number; realMin: number; estMin: number }[];
}

export function interpolationAccuracy(
  center: LatLng,
  realProbes: { bearing: number; straightM: number; distM: number }[],
  factorsAt: (thetaDeg: number) => number,
  speed: number
): AccuracyReport {
  const details = realProbes.map(({ bearing, straightM, distM }) => {
    const realMin = distM / speed;
    const f = factorsAt(bearing);
    const estMin = (straightM * f) / speed;
    return {
      bearing: Math.round(bearing),
      straightM: Math.round(straightM),
      realMin: Math.round(realMin * 10) / 10,
      estMin: Math.round(estMin * 10) / 10
    };
  });
  if (!details.length) {
    return { samples: 0, maeMinutes: 0, maePercent: 0, worstPercent: 0, details: [] };
  }
  const abs = details.map((d) => Math.abs(d.realMin - d.estMin));
  const maeMinutes = Math.round((abs.reduce((a, b) => a + b, 0) / abs.length) * 100) / 100;
  const percents = details.map((d) => (d.realMin > 0 ? Math.abs(d.realMin - d.estMin) / d.realMin : 0));
  const maePercent = Math.round((percents.reduce((a, b) => a + b, 0) / percents.length) * 1000) / 10;
  const worstPercent = Math.round(Math.max(...percents) * 1000) / 10;
  return { samples: details.length, maeMinutes, maePercent, worstPercent, details };
}
