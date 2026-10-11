import type { CategoryId, ChannelName, Poi, PoiSearchResult } from '../shared/types.js';

/**
 * 浏览器端 POI 结果缓存（localStorage，TTL 6 小时）：
 * 同一位置（约 100m 网格）重复分析时直接命中，不消耗任何检索配额。
 * 这是对「JS 地点检索」配额的第一道防线——答辩反复演示同一社区时零成本。
 */

const PREFIX = 'lc-poi-v2:'; // v2: 不再缓存空结果（v1 曾把限流抖动的空返回固化 6 小时）
const TTL = 6 * 3600 * 1000;
const MAX_ENTRIES = 200;

interface CacheEntry {
  channel: ChannelName;
  at: number;
  pois: Poi[];
}

export function poiCacheKey(keyword: string, center: { lat: number; lng: number }, radiusM: number): string {
  // ~110m 网格取整，位置微移不击穿缓存
  return `${PREFIX}${keyword}@${center.lat.toFixed(3)},${center.lng.toFixed(3)}@${radiusM}`;
}

export function getCachedPois(key: string): CacheEntry | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const entry = JSON.parse(raw) as CacheEntry;
    if (Date.now() - entry.at > TTL) {
      localStorage.removeItem(key);
      return null;
    }
    return entry;
  } catch {
    return null;
  }
}

export function setCachedPois(key: string, entry: CacheEntry): void {
  try {
    localStorage.setItem(key, JSON.stringify(entry));
    // 简单容量控制：超限清掉最旧的一半
    const keys: { key: string; at: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) {
        try {
          keys.push({ key: k, at: (JSON.parse(localStorage.getItem(k)!) as CacheEntry).at });
        } catch {
          localStorage.removeItem(k);
        }
      }
    }
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => a.at - b.at);
      for (const { key: k } of keys.slice(0, Math.floor(keys.length / 2))) localStorage.removeItem(k);
    }
  } catch {
    /* 存储满/不可用：缓存是 best-effort */
  }
}

const SEARCH_PREFIX = 'lc-poi-search-v1:';

export function detailedSearchKey(keyword: string, center: { lat: number; lng: number }, radiusM: number,
  category: CategoryId, channels: ChannelName[]): string {
  // Do not reuse a rounded 100m cache for a different project center or gateway configuration.
  return `${SEARCH_PREFIX}${JSON.stringify([keyword, center.lat, center.lng, radiusM, category, channels])}`;
}

export function getCachedSearch(key: string): PoiSearchResult | null {
  try {
    const entry = JSON.parse(localStorage.getItem(key) ?? 'null');
    const value = entry?.value as PoiSearchResult | undefined;
    if (!value || !Array.isArray(value.pois) || value.completeness?.status !== 'complete' ||
      !Number.isFinite(entry.at) || Date.now() - entry.at > TTL || entry.at > Date.now()) return null;
    if (!Number.isFinite(Date.parse(value.completeness.collectedAt)) ||
      Date.now() - Date.parse(value.completeness.collectedAt) > TTL) return null;
    return { ...value, completeness: { ...value.completeness, cacheHit: true } };
  } catch { return null; }
}

export function setCachedSearch(key: string, value: PoiSearchResult): void {
  if (value.completeness.status !== 'complete' || value.completeness.source === 'mock') return;
  try {
    localStorage.setItem(key, JSON.stringify({ at: Date.now(), value }));
    const entries: { key: string; at: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k?.startsWith(SEARCH_PREFIX)) continue;
      try { entries.push({ key: k, at: JSON.parse(localStorage.getItem(k)!).at ?? 0 }); }
      catch { /* Corrupt cache entries are ignored, never affect saved projects. */ }
    }
    entries.sort((a, b) => a.at - b.at);
    for (const item of entries.slice(0, Math.max(0, entries.length - MAX_ENTRIES))) localStorage.removeItem(item.key);
  } catch { /* Cache is optional; project save errors are reported separately. */ }
}
