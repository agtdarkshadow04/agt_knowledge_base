/**
 * The response headers of every response (SEC-1..SEC-3), in a module without
 * imports so the browser tests' static server (tests/e2e/serve.ts) sends
 * exactly the production headers.
 */

/** SEC-1: the exact Content-Security-Policy. Never widen it (WF-4). */
export const contentSecurityPolicy = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'", "img-src 'self' https: http: blob:",
  "font-src 'self'", "connect-src 'self'", "media-src 'self'", "worker-src 'self'", "object-src 'none'",
  "base-uri 'self'", "form-action 'self'", "frame-ancestors 'none'",
].join('; ');

/** SEC-1 and SEC-2: on every response. */
export const securityHeaders = {
  'content-security-policy': contentSecurityPolicy,
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'cross-origin-opener-policy': 'same-origin',
};

/** SEC-3: API and HTML responses are never cached; only hashed `/assets/` files are. */
export const noStoreHeaders = {
  'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
  pragma: 'no-cache',
  expires: '0',
};
