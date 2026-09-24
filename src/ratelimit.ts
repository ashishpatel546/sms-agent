/** Fixed-window request counter per key, in memory. */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Records a hit; returns seconds to wait if the key is over its limit. */
  take(key: string, now = Date.now()): number {
    if (this.hits.size > 10_000) {
      for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
    }
    const h = this.hits.get(key);
    if (!h || h.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return 0;
    }
    if (h.count >= this.limit) return Math.ceil((h.resetAt - now) / 1000);
    h.count++;
    return 0;
  }
}
