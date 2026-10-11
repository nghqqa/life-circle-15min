/** 令牌桶限流：按桶名（服务维度）保护上游 QPS，按 IP 保护本服务 */

export class TokenBucket {
  private tokens: number;
  private last = Date.now();

  constructor(
    private capacity: number,
    private refillPerSec: number
  ) {
    this.tokens = capacity;
  }

  private refill() {
    const now = Date.now();
    const add = ((now - this.last) / 1000) * this.refillPerSec;
    if (add > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + add);
      this.last = now;
    }
  }

  tryTake(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** 阻塞获取，超时返回 false */
  async take(timeoutMs = 4000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (this.tryTake()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((r) => setTimeout(r, 60));
    }
  }
}

/** 每 IP 滑动窗口计数器 */
export class IpLimiter {
  private windows = new Map<string, number[]>();

  constructor(
    private windowMs = 60_000,
    private maxPerWindow = 600
  ) {}

  allow(ip: string): boolean {
    const now = Date.now();
    const arr = (this.windows.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (arr.length >= this.maxPerWindow) {
      this.windows.set(ip, arr);
      return false;
    }
    arr.push(now);
    this.windows.set(ip, arr);
    if (this.windows.size > 5000) this.windows.clear();
    return true;
  }
}
