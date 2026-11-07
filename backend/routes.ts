import type { Actor } from './domain.js';

export interface AdminIdentity {
  username: string;
}

export interface ApiRequest {
  routeKey: string;
  pathParameters: Record<string, string>;
  query: Record<string, string>;
  /** The UTF-8 request body, for JSON routes. */
  body?: string;
  /** The raw request body, for routes declared with `rawBody` (backup uploads). */
  rawBody?: Buffer;
  /** The signed-in member, or null on public and admin routes and anonymous requests. */
  actor: Actor | null;
  /** The signed-in installation Admin; set only on admin routes. */
  admin?: AdminIdentity | null;
  requestId: string;
}

export interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body?: string | Buffer;
}

/**
 * - `none`: no credentials are checked (public reads, member sign-in, Admin setup and sign-in).
 * - `member`: a member bearer token is required; admin cookies are ignored.
 * - `admin`: an Admin session cookie is required; bearer tokens are ignored.
 */
export type RouteAuth = 'none' | 'member' | 'admin';
export type RateLimitName = 'login' | 'adminLogin' | 'setup' | 'adminPassword';

interface RouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  auth: RouteAuth;
  /** Largest accepted body in bytes, or `backup` for the effective `backup.maxBytes`. */
  maxBodyBytes?: number | 'backup';
  /** Pass the body to the handler as a Buffer instead of a string. */
  rawBody?: boolean;
  /** Rate limit applied before authentication and body parsing. */
  rateLimit?: RateLimitName;
}

export const defaultMaxBodyBytes = 1_000_000;

// The single list of API routes. Literal paths are listed before parameterized
// paths that could otherwise match them.
const routes: RouteDefinition[] = [
  { method: 'POST', path: '/auth/login', auth: 'none', rateLimit: 'login' },
  { method: 'GET', path: '/auth/session', auth: 'member' },
  { method: 'GET', path: '/settings', auth: 'none' },

  { method: 'GET', path: '/articles', auth: 'none' },
  { method: 'POST', path: '/articles', auth: 'member' },
  { method: 'GET', path: '/articles/{id}', auth: 'none' },
  { method: 'PUT', path: '/articles/{id}', auth: 'member' },
  { method: 'DELETE', path: '/articles/{id}', auth: 'member' },
  { method: 'GET', path: '/articles/{id}/revisions', auth: 'member' },
  { method: 'POST', path: '/articles/{id}/revisions/{version}/restore', auth: 'member' },
  { method: 'PATCH', path: '/articles/{id}/protection', auth: 'member' },
  { method: 'PATCH', path: '/articles/{id}/pinning', auth: 'member' },
  { method: 'PATCH', path: '/articles/{id}/verification', auth: 'member' },
  { method: 'DELETE', path: '/articles/{id}/orphan-tags/{tagId}', auth: 'member' },

  { method: 'GET', path: '/tags', auth: 'none' },
  { method: 'POST', path: '/tags', auth: 'member' },
  { method: 'GET', path: '/tags/orphans', auth: 'member' },
  { method: 'PUT', path: '/tags/{tagId}', auth: 'member' },
  { method: 'DELETE', path: '/tags/{tagId}', auth: 'member' },

  { method: 'GET', path: '/member/articles', auth: 'member' },
  { method: 'GET', path: '/member/articles/{id}', auth: 'member' },
  { method: 'GET', path: '/member/tags', auth: 'member' },

  // Admin setup and authentication, served by the HTTP server itself.
  { method: 'GET', path: '/admin/setup/status', auth: 'none' },
  { method: 'POST', path: '/admin/setup', auth: 'none', rateLimit: 'setup' },
  { method: 'POST', path: '/admin/auth/login', auth: 'none', rateLimit: 'adminLogin' },
  { method: 'POST', path: '/admin/auth/logout', auth: 'admin' },
  { method: 'GET', path: '/admin/auth/session', auth: 'admin' },
  { method: 'PUT', path: '/admin/auth/password', auth: 'admin', rateLimit: 'adminPassword' },

  { method: 'GET', path: '/admin/users', auth: 'admin' },
  { method: 'POST', path: '/admin/users', auth: 'admin' },
  { method: 'PUT', path: '/admin/users/{userId}', auth: 'admin' },
  { method: 'PUT', path: '/admin/users/{userId}/password', auth: 'admin' },
  { method: 'DELETE', path: '/admin/users/{userId}', auth: 'admin' },
  { method: 'GET', path: '/admin/stats', auth: 'admin' },
  { method: 'GET', path: '/admin/articles', auth: 'admin' },
  { method: 'GET', path: '/admin/settings', auth: 'admin' },
  { method: 'PUT', path: '/admin/settings', auth: 'admin' },
  { method: 'GET', path: '/admin/backup', auth: 'admin' },
  { method: 'POST', path: '/admin/backup/restore', auth: 'admin', maxBodyBytes: 'backup', rawBody: true },
];

const compiled = routes.map((route) => {
  const names: string[] = [];
  const source = route.path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    names.push(name);
    return '([^/]+)';
  });
  return { ...route, routeKey: `${route.method} ${route.path}`, pattern: new RegExp(`^${source}$`), names };
});

/** Every declared route key, e.g. `GET /articles/{id}`. */
export const routeKeys: readonly string[] = compiled.map((route) => route.routeKey);

const byKey = new Map(compiled.map((route) => [route.routeKey, route]));

/** Whether a path belongs to the admin API, which uses cookie sessions and CSRF headers. */
export function isAdminPath(pathname: string) {
  return pathname === '/admin' || pathname.startsWith('/admin/');
}

/**
 * The largest request body accepted for a route key. The restore route takes
 * the effective `backup.maxBytes` setting, which the caller resolves.
 */
export function maxBodyBytes(routeKey: string, backupMaxBytes?: number) {
  const limit = byKey.get(routeKey)?.maxBodyBytes;
  if (limit === 'backup') {
    if (backupMaxBytes === undefined) throw new Error(`${routeKey} needs the effective backup.maxBytes setting.`);
    return backupMaxBytes;
  }
  return limit ?? defaultMaxBodyBytes;
}

export function usesBackupBodyLimit(routeKey: string) {
  return byKey.get(routeKey)?.maxBodyBytes === 'backup';
}

export interface RouteMatch {
  routeKey: string;
  pathParameters: Record<string, string>;
  auth: RouteAuth;
  rawBody: boolean;
  rateLimit?: RateLimitName;
}

export function matchRoute(method: string, pathname: string): RouteMatch | null {
  for (const route of compiled) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    const pathParameters = Object.fromEntries(route.names.map((name, index) => [name, match[index + 1]]));
    return {
      routeKey: route.routeKey,
      pathParameters,
      auth: route.auth,
      rawBody: route.rawBody ?? false,
      ...(route.rateLimit ? { rateLimit: route.rateLimit } : {}),
    };
  }
  return null;
}
