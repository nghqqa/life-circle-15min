import type { LatLng } from '../shared/types.js';

/**
 * №9 住宅样本人工补录（全局单库，跨项目共享）：
 * - 补录样本在下一次体检并入住宅采样（名称带「(补录)」后缀，来源标记 client）；
 * - 50m 内视为重复录入（提示）；偏离分析中心超过采样半径记为异常（提示但保留）；
 * - 每条强制携带来源与日期；户数/人口为可选汇总字段，与住宅样本口径分开展示，不混用分母。
 */

const STORE_KEY = 'lc-res-supplements-v1';
export interface SupplementEntry {
  name: string;
  latLng: LatLng;
  households?: number;
  source: string;
  at: string;
}

export interface SupplementStore {
  entries: SupplementEntry[];
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

function dist(a: LatLng, b: LatLng): number {
  const R = 6371008.8;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function getSupplements(storage: StorageLike = localStorage): SupplementStore | null {
  try {
    const raw = JSON.parse(storage.getItem(STORE_KEY) ?? 'null');
    if (!raw || !Array.isArray(raw.entries)) return null;
    return raw as SupplementStore;
  } catch { return null; }
}

export interface AddResult {
  ok: boolean;
  duplicate?: SupplementEntry;
  abnormal?: boolean;
  store: SupplementStore;
}

export function addSupplement(
  center: LatLng, radiusM: number,
  entry: { name: string; lat: number; lng: number; households?: number; source: string },
  storage: StorageLike = localStorage
): AddResult | null {
  if (!Number.isFinite(entry.lat) || !Number.isFinite(entry.lng) || Math.abs(entry.lat) > 85 || Math.abs(entry.lng) > 180) return null;
  if (!entry.name.trim() || !entry.source.trim()) return null;
  const store = getSupplements(storage) ?? { entries: [] };
  const latLng = { lat: entry.lat, lng: entry.lng };
  const duplicate = store.entries.find((e) => dist(e.latLng, latLng) <= 50);
  const record: SupplementEntry = {
    name: entry.name.trim().slice(0, 60),
    latLng,
    ...(Number.isFinite(entry.households) && entry.households! > 0 ? { households: Math.floor(entry.households!) } : {}),
    source: entry.source.trim().slice(0, 100),
    at: new Date().toISOString()
  };
  store.entries.push(record);
  try { storage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* 存储满提示 */ }
  return {
    ok: true, duplicate, store,
    abnormal: dist(center, latLng) > radiusM
  };
}

export function removeSupplement(center: LatLng, index: number, storage: StorageLike = localStorage): SupplementStore | null {
  const store = getSupplements(storage);
  if (!store || index < 0 || index >= store.entries.length) return store;
  store.entries.splice(index, 1);
  try { storage.setItem(STORE_KEY, JSON.stringify(store)); } catch { /* best-effort */ }
  return store;
}

/** 并入体检：取分析中心 radiusM 内的补录样本（来源标记 client + 名称后缀，warnings 单独说明） */
export function supplementPois(center: LatLng, radiusM = 2500, storage: StorageLike = localStorage): { name: string; lat: number; lng: number }[] {
  const store = getSupplements(storage);
  return (store?.entries ?? [])
    .filter((e) => dist(e.latLng, center) <= radiusM)
    .map((e) => ({ name: `${e.name}(补录)`, lat: e.latLng.lat, lng: e.latLng.lng }));
}
