import type { IncomingMessage } from 'node:http';

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

/**
 * The client's address. X-Forwarded-For is used only when `trustProxy` allows:
 * `true` trusts every hop (the left-most address wins), a number trusts that
 * many proxies nearest the API, and `false` uses the socket address.
 */
export function clientAddress(request: Pick<IncomingMessage, 'headers' | 'socket'>, trustProxy: boolean | number) {
  const socketAddress = request.socket.remoteAddress ?? 'unknown';
  if (trustProxy === false || trustProxy === 0) return socketAddress;
  const header = request.headers['x-forwarded-for'];
  const forwarded = (Array.isArray(header) ? header.join(',') : header ?? '')
    .split(',').map((value) => value.trim()).filter(Boolean);
  const chain = [...forwarded, socketAddress];
  if (trustProxy === true) return chain[0];
  return chain[Math.max(0, chain.length - 1 - trustProxy)];
}
