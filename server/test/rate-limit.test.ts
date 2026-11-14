import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RateLimiter } from '../rate-limit.js';


describe('rate limiter', () => {
  it('allows the configured number of attempts per window, then reports when to retry', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    const rule = { max: 2, windowMinutes: 1 };
    assert.deepEqual(limiter.hit('login', '10.0.0.1', rule), { allowed: true });
    assert.deepEqual(limiter.hit('login', '10.0.0.1', rule), { allowed: true });
    now = 15_000;
    assert.deepEqual(limiter.hit('login', '10.0.0.1', rule), { allowed: false, retryAfterSeconds: 45 });
    // Other clients and other buckets are counted separately.
    assert.deepEqual(limiter.hit('login', '10.0.0.2', rule), { allowed: true });
    assert.deepEqual(limiter.hit('adminLogin', '10.0.0.1', rule), { allowed: true });
  });

  it('resets when the window ends', () => {
    let now = 0;
    const limiter = new RateLimiter(() => now);
    const rule = { max: 1, windowMinutes: 1 };
    limiter.hit('setup', 'client', rule);
    assert.equal(limiter.hit('setup', 'client', rule).allowed, false);
    now = 60_000;
    assert.equal(limiter.hit('setup', 'client', rule).allowed, true);
  });
});
