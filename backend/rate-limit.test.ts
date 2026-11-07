// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { clientAddress, RateLimiter } from './rate-limit.js';

function request(remoteAddress: string, forwardedFor?: string) {
  return { socket: { remoteAddress }, headers: forwardedFor ? { 'x-forwarded-for': forwardedFor } : {} } as never;
}

describe('rate limiter', () => {
  it('allows the configured number of attempts per window, then reports when to retry', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    const rule = { max: 2, windowMinutes: 1 };
    expect(limiter.hit('login', '10.0.0.1', rule)).toEqual({ allowed: true });
    expect(limiter.hit('login', '10.0.0.1', rule)).toEqual({ allowed: true });
    now = 15_000;
    expect(limiter.hit('login', '10.0.0.1', rule)).toEqual({ allowed: false, retryAfterSeconds: 45 });
    // Other clients and other buckets are counted separately.
    expect(limiter.hit('login', '10.0.0.2', rule)).toEqual({ allowed: true });
    expect(limiter.hit('adminLogin', '10.0.0.1', rule)).toEqual({ allowed: true });
  });

  it('resets when the window ends', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    const rule = { max: 1, windowMinutes: 1 };
    limiter.hit('setup', 'client', rule);
    expect(limiter.hit('setup', 'client', rule).allowed).toBe(false);
    now = 60_000;
    expect(limiter.hit('setup', 'client', rule).allowed).toBe(true);
  });
});

describe('client address', () => {
  it('ignores X-Forwarded-For unless the proxy is trusted', () => {
    expect(clientAddress(request('172.18.0.5', '203.0.113.9'), false)).toBe('172.18.0.5');
    expect(clientAddress(request('172.18.0.5', '203.0.113.9'), 0)).toBe('172.18.0.5');
  });

  it('takes the address the trusted proxy hops saw', () => {
    // Nginx appends the address it saw; a forged left-most entry is ignored with one trusted hop.
    expect(clientAddress(request('172.18.0.5', '198.51.100.1, 203.0.113.9'), 1)).toBe('203.0.113.9');
    // Behind a TLS proxy and Nginx, two hops are trusted.
    expect(clientAddress(request('172.18.0.5', '203.0.113.9, 10.0.0.2'), 2)).toBe('203.0.113.9');
    expect(clientAddress(request('172.18.0.5', '203.0.113.9'), 5)).toBe('203.0.113.9');
    expect(clientAddress(request('172.18.0.5', '198.51.100.1, 203.0.113.9'), true)).toBe('198.51.100.1');
    expect(clientAddress(request('172.18.0.5'), 1)).toBe('172.18.0.5');
  });
});
