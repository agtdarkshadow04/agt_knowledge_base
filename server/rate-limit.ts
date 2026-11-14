export interface RateLimitRule {
  max: number;
  windowMinutes: number;
}

export type RateLimitResult = { allowed: true } | { allowed: false; retryAfterSeconds: number };

/**
 * A fixed-window, in-memory limiter keyed by bucket and client address. It
 * lives in the single API process, so limits reset when the API restarts.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  hit(bucket: string, client: string, rule: RateLimitRule): RateLimitResult {
    const now = this.now();
    const key = `${bucket}\u0000${client}`;
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + rule.windowMinutes * 60_000 };
      this.windows.set(key, window);
    }
    window.count += 1;
    if (this.windows.size > 10_000) this.prune(now);
    if (window.count <= rule.max) return { allowed: true };
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000)) };
  }

  private prune(now: number) {
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}
