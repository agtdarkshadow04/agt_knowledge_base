import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { sharedRateLimitStore } from '../rate-limit.js';

type Result = { current: number; ttl: number };
interface Store { incr(key: string, callback: (error: Error | null, result: Result) => void, timeWindow?: number): void }

function incr(store: Store, key: string, timeWindow: number) {
  let result: Result | undefined;
  store.incr(key, (_error, value) => { result = value; }, timeWindow);
  return result!;
}

describe('shared rate-limit store (SEC-7)', () => {
  it('counts per key in a fixed window and resets when it ends', () => {
    let now = 1_000;
    const Store = sharedRateLimitStore(() => now);
    const store = new Store();
    assert.deepEqual(incr(store, '10.0.0.1login', 60_000), { current: 1, ttl: 60_000 });
    now += 15_000;
    assert.deepEqual(incr(store, '10.0.0.1login', 60_000), { current: 2, ttl: 45_000 });
    assert.deepEqual(incr(store, '10.0.0.2login', 60_000), { current: 1, ttl: 60_000 });
    assert.deepEqual(incr(store, '10.0.0.1setup', 60_000), { current: 1, ttl: 60_000 });
    now += 45_000;
    assert.deepEqual(incr(store, '10.0.0.1login', 60_000), { current: 1, ttl: 60_000 });
  });

  it('shares one map between routes, so a bucket counts across them', () => {
    const Store = sharedRateLimitStore(() => 0);
    const store = new Store();
    assert.equal(store.child(), store);
    incr(store, 'ipadminLogin', 60_000);
    assert.equal(incr(store.child(), 'ipadminLogin', 60_000).current, 2);
  });
});
