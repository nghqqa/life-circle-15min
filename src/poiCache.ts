import type { ChannelName, Poi } from '../shared/types.js';

/**
 * 浏览器端 POI 结果缓存（localStorage，TTL 6 小时）：
 * 同一位置（约 100m 网格）重复分析时直接命中，不消耗任何检索配额。
 * 这是对「JS 地点检索」配额的第一道防线——答辩反复演示同一社区时零成本。
 */

const PREFIX = 'lc-poi-v1:';
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
