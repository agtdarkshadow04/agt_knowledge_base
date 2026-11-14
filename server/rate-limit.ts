/**
 * The store behind `@fastify/rate-limit` (SEC-7). The plugin's own in-memory
 * store keeps a separate map per route; this one is shared, and the plugin
 * appends each route's `groupId` (its rate-limit bucket) to the key, so a
 * deprecated path and its replacement count against the same limit. It is a
 * fixed window per client address and bucket, kept in memory: limits reset
 * when the server restarts.
 */

interface Window {
  current: number;
  startedAt: number;
  length: number;
}

type IncrCallback = (error: Error | null, result: { current: number; ttl: number }) => void;

/** A store class for the plugin's `store` option; `now` is replaceable in tests. */
export function sharedRateLimitStore(now: () => number = Date.now) {
  const windows = new Map<string, Window>();

  function prune(at: number) {
    for (const [key, window] of windows) if (window.startedAt + window.length <= at) windows.delete(key);
  }

  return class SharedRateLimitStore {
    incr(key: string, callback: IncrCallback, timeWindow = 60_000) {
      const at = now();
      let window = windows.get(key);
      if (!window || window.startedAt + timeWindow <= at) {
        window = { current: 0, startedAt: at, length: timeWindow };
        windows.set(key, window);
      }
      window.current += 1;
      if (windows.size > 10_000) prune(at);
      callback(null, { current: window.current, ttl: window.startedAt + timeWindow - at });
    }

    child() {
      return this;
    }
  };
}
