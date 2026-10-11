/** 内存 TTL 缓存：算路 / POI 结果按归一化 key 复用，显著降低配额消耗与响应延迟 */

export class TtlCache<V> {
  private map = new Map<string, { exp: number; value: V }>();
  hits = 0;
  misses = 0;

  constructor(
    private ttlMs: number,
    private max = 3000
  ) {}

  get(key: string): V | undefined {
    const hit = this.map.get(key);
    if (!hit) {
      this.misses++;
      return undefined;
    }
    if (Date.now() > hit.exp) {
      this.map.delete(key);
      this.misses++;
      return undefined;
    }
    this.hits++;
    // LRU 触碰
    this.map.delete(key);
    this.map.set(key, hit);
    return hit.value;
  }

  set(key: string, value: V): void {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    this.map.set(key, { exp: Date.now() + this.ttlMs, value });
  }

  stats() {
    return { size: this.map.size, hits: this.hits, misses: this.misses };
  }
}
