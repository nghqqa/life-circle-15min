import type { LatLng } from '../shared/types.js';

/**
 * №11 行政边界筛选：导入 GeoJSON（Polygon/MultiPolygon）作为分析范围，
 * 范围外的采样与设施不参与统计；边界仅作范围筛选，不改变评分规则。
 */

const STORE_KEY = 'lc-boundary-v1';
const PI = Math.PI;
const X_PI = (PI * 3000) / 180;

function outOfChina(lat: number, lng: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271;
}
function transformLat(x: number, y: number): number {
  let ret = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  ret += (20 * Math.sin(y * PI) + 40 * Math.sin(y / 3 * PI)) * 2 / 3;
  ret += (160 * Math.sin(y / 12 * PI) + 320 * Math.sin(y * PI / 30)) * 2 / 3;
  return ret;
}
function transformLng(x: number, y: number): number {
  let ret = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20 * Math.sin(6 * x * PI) + 20 * Math.sin(2 * x * PI)) * 2 / 3;
  ret += (20 * Math.sin(x * PI) + 40 * Math.sin(x / 3 * PI)) * 2 / 3;
  ret += (150 * Math.sin(x / 12 * PI) + 300 * Math.sin(x / 30 * PI)) * 2 / 3;
  return ret;
}

/** 审查修复：GeoJSON 通用 WGS-84 → 百度 BD-09（离线标准近似，误差约 1-2m） */
export function wgs84ToBd09(lat: number, lng: number): LatLng {
  if (outOfChina(lat, lng)) return { lat, lng };
  let dLat = transformLat(lng - 105, lat - 35);
  let dLng = transformLng(lng - 105, lat - 35);
  const radLat = (lat / 180) * PI;
  const magic = 1 - 0.00669342162296594326 * Math.sin(radLat) ** 2;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180) / (((6378245 * (1 - 0.00669342162296594326)) / (magic * sqrtMagic)) * PI);
  dLng = (dLng * 180) / ((6378245 / sqrtMagic) * Math.cos(radLat) * PI);
  const gLat = lat + dLat;
  const gLng = lng + dLng;
  const z = Math.sqrt(gLng * gLng + gLat * gLat) + 0.00002 * Math.sin(gLat * X_PI);
  const theta = Math.atan2(gLat, gLng) + 0.000003 * Math.cos(gLng * X_PI);
  return { lat: z * Math.sin(theta) + 0.006, lng: z * Math.cos(theta) + 0.0065 };
}

export interface Boundary {
  name: string;
  /** 每个多边形的外环，顶点为 [lng, lat] GeoJSON 顺序（审查修复：MultiPolygon 全部保留） */
  polygons: [number, number][][];
  /** 内洞（enclave）：洞内的点视为边界外 */
  holes: [number, number][][];
  vertexCount: number;
  importedAt: string;
  /** 源坐标系：导入时假定 WGS-84 并自动转换为百度 BD-09 */
  sourceCoordinateSystem: 'WGS-84' | 'BD-09';
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
  const holes: [number, number][][] = [];
  let vertexCount = 0;
  // 审查修复：Polygon 与 MultiPolygon 逐多边形取外环；内洞（index ≥1）作为排除区保留
  for (const g of geoms) {
    const polys: any[][] = g.type === 'Polygon' ? [g.coordinates] : (g.coordinates ?? []);
    for (const rings of polys) {
      const exterior = rings?.[0];
      if (!Array.isArray(exterior) || exterior.length < 4) continue;
      const ring: [number, number][] = exterior.map((pt: any) => {
        const bd = wgs84ToBd09(Number(pt[1]), Number(pt[0]));
        return [bd.lng, bd.lat] as [number, number];
      });
      if (ring.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) continue;
      polygons.push(ring);
      vertexCount += ring.length;
      for (let h = 1; h < (rings ?? []).length; h++) {
        const hole = (rings[h] ?? []).map((pt: any) => {
          const bd = wgs84ToBd09(Number(pt[1]), Number(pt[0]));
          return [bd.lng, bd.lat] as [number, number];
        });
        if (hole.length >= 4 && hole.every((c: [number, number]) => Number.isFinite(c[0]) && Number.isFinite(c[1]))) {
          holes.push(hole);
          vertexCount += hole.length;
        }
      }
    }
  }
  if (!polygons.length) return null;
  return { name, polygons, holes, vertexCount, importedAt: new Date().toISOString(), sourceCoordinateSystem: 'WGS-84' };
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
  const inExterior = b.polygons.some((ring) => pointInRing(p.lng, p.lat, ring));
  if (!inExterior) return false;
  // 审查修复：内洞视为边界外（enclave 不参与统计）
  return !b.holes.some((hole) => pointInRing(p.lng, p.lat, hole));
}

export function saveBoundary(b: Boundary, storage: StorageLike = localStorage): void {
  try { storage.setItem(STORE_KEY, JSON.stringify(b)); } catch { /* best-effort */ }
}
