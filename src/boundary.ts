import type { LatLng } from '../shared/types.js';

/**
 * №11 行政边界筛选：导入 GeoJSON（Polygon/MultiPolygon）作为分析范围，
 * 范围外的采样与设施不参与统计；边界仅作范围筛选，不改变评分规则。
 */

const STORE_KEY = 'lc-boundary-v1';

export interface Boundary {
  name: string;
  /** 外环列表（每个多边形一个外环），顶点为 [lng, lat] GeoJSON 顺序 */
  polygons: [number, number][][];
  vertexCount: number;
  importedAt: string;
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function getBoundary(storage: StorageLike = localStorage): Boundary | null {
  try {
    const raw = JSON.parse(storage.getItem(STORE_KEY) ?? 'null');
    if (!raw || !Array.isArray(raw.polygons) || !raw.polygons.length) return null;
    return raw as Boundary;
  } catch { return null; }
}

export function clearBoundary(storage: StorageLike = localStorage): void {
  try { storage.removeItem(STORE_KEY); } catch { /* best-effort */ }
}

/** 解析 GeoJSON：接受 Feature / FeatureCollection / Geometry，取 Polygon / MultiPolygon */
export function parseBoundaryGeoJson(text: string, name = '导入边界'): Boundary | null {
  let json: any;
  try { json = JSON.parse(text); } catch { return null; }
  const geoms: any[] = [];
  const collect = (node: any) => {
    if (!node) return;
    if (node.type === 'Feature') collect(node.geometry);
    else if (node.type === 'FeatureCollection') (node.features ?? []).forEach(collect);
    else if (node.type === 'Polygon' || node.type === 'MultiPolygon') geoms.push(node);
  };
  collect(json);
  const polygons: [number, number][][] = [];
  let vertexCount = 0;
  for (const g of geoms) {
    const rings = g.type === 'Polygon' ? g.coordinates : (g.coordinates ?? []).flat();
    const exterior = rings?.[0];
    if (!Array.isArray(exterior) || exterior.length < 4) continue;
    const ring: [number, number][] = exterior.map((pt: any) => [Number(pt[0]), Number(pt[1])]);
    if (ring.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) continue;
    polygons.push(ring);
    vertexCount += ring.length;
  }
  if (!polygons.length) return null;
  return { name, polygons, vertexCount, importedAt: new Date().toISOString() };
}

/** 射线法：点是否在单个外环内（GeoJSON 顶点顺序 [lng, lat]） */
export function pointInRing(lng: number, lat: number, ring: [number, number][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi + Number.EPSILON) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

export function pointInBoundary(p: LatLng, b: Boundary | null): boolean {
  if (!b) return true;
  return b.polygons.some((ring) => pointInRing(p.lng, p.lat, ring));
}

export function saveBoundary(b: Boundary, storage: StorageLike = localStorage): void {
  try { storage.setItem(STORE_KEY, JSON.stringify(b)); } catch { /* best-effort */ }
}
