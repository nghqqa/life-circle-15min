import { localDistM } from './geo.js';
import type { CategoryId, LatLng, Poi } from './types.js';

/** POI 清洗：按 uid 与「名称相似 + 距离近」两级去重，剔除无效坐标 */
export function dedupePois(pois: Poi[]): Poi[] {
  const byUid = new Map<string, Poi>();
  const out: Poi[] = [];
  for (const p of pois) {
    if (!isFinite(p.lat) || !isFinite(p.lng) || (p.lat === 0 && p.lng === 0)) continue;
    if (byUid.has(p.uid)) continue;
    byUid.set(p.uid, p);
    out.push(p);
  }
  // 名称相同且相距 <50m 视为同一设施的不同别名（如“XX药房(旗舰店)”）
  const byName = new Map<string, Poi[]>();
  const kept: Poi[] = [];
  for (const p of out) {
    const key = normalizeName(p.name);
    const bucket = byName.get(key) ?? [];
    const dup = bucket.some((q) => localDistM(p.lat, p.lng, q.lat, q.lng) < 50);
    if (dup) continue;
    bucket.push(p);
    byName.set(key, bucket);
    kept.push(p);
  }
  return kept;
}

function normalizeName(name: string): string {
  return name.replace(/[（(].*?[)）]/g, '').replace(/\s+/g, '');
}

export function nearestPoiM(p: LatLng, pois: Poi[]): { distM: number; poi: Poi } | null {
  let best: { distM: number; poi: Poi } | null = null;
  for (const q of pois) {
    const d = localDistM(p.lat, p.lng, q.lat, q.lng);
    if (!best || d < best.distM) best = { distM: d, poi: q };
  }
  return best;
}

export function poisByCategory(pois: Poi[]): Record<CategoryId, Poi[]> {
  const map = {} as Record<CategoryId, Poi[]>;
  for (const p of pois) {
    (map[p.category] ??= []).push(p);
  }
  return map;
}
