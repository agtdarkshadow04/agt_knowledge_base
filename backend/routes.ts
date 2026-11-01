import type { Actor } from './domain.js';

export interface ApiRequest {
  routeKey: string;
  pathParameters: Record<string, string>;
  query: Record<string, string>;
  body?: string;
  /** The signed-in user, or null on public routes and anonymous requests. */
  actor: Actor | null;
  requestId: string;
}

export interface ApiResponse {
  statusCode: number;
  headers: Record<string, string>;
  body?: string;
}

interface RouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  /** Whether the server must verify a bearer token before dispatching. */
  authenticated: boolean;
  /** Largest accepted request body in bytes; defaults to `defaultMaxBodyBytes`. */
  maxBodyBytes?: number;
}

export const defaultMaxBodyBytes = 1_000_000;
/** Keep in step with `client_max_body_size` for `/api/admin/backup` in nginx.conf. */
export const backupMaxBodyBytes = 100 * 1024 * 1024;

// The single list of API routes. Literal paths are listed before parameterized
// paths that could otherwise match them.
const routes: RouteDefinition[] = [
  { method: 'POST', path: '/auth/login', authenticated: false },
  { method: 'GET', path: '/auth/session', authenticated: true },
  { method: 'GET', path: '/setup/status', authenticated: false },
  { method: 'POST', path: '/setup', authenticated: false },
  { method: 'GET', path: '/settings', authenticated: false },

  { method: 'GET', path: '/articles', authenticated: false },
  { method: 'POST', path: '/articles', authenticated: true },
  { method: 'GET', path: '/articles/{id}', authenticated: false },
  { method: 'PUT', path: '/articles/{id}', authenticated: true },
  { method: 'DELETE', path: '/articles/{id}', authenticated: true },
  { method: 'GET', path: '/articles/{id}/revisions', authenticated: true },
  { method: 'POST', path: '/articles/{id}/revisions/{version}/restore', authenticated: true },
  { method: 'PATCH', path: '/articles/{id}/protection', authenticated: true },
  { method: 'PATCH', path: '/articles/{id}/pinning', authenticated: true },
  { method: 'PATCH', path: '/articles/{id}/verification', authenticated: true },
  { method: 'DELETE', path: '/articles/{id}/orphan-tags/{tagId}', authenticated: true },

  { method: 'GET', path: '/tags', authenticated: false },
  { method: 'POST', path: '/tags', authenticated: true },
  { method: 'GET', path: '/tags/orphans', authenticated: true },
  { method: 'PUT', path: '/tags/{tagId}', authenticated: true },
  { method: 'DELETE', path: '/tags/{tagId}', authenticated: true },

  { method: 'GET', path: '/member/articles', authenticated: true },
  { method: 'GET', path: '/member/articles/{id}', authenticated: true },
  { method: 'GET', path: '/member/tags', authenticated: true },

  { method: 'GET', path: '/admin/users', authenticated: true },
  { method: 'POST', path: '/admin/users', authenticated: true },
  { method: 'PUT', path: '/admin/users/{userId}', authenticated: true },
  { method: 'PUT', path: '/admin/users/{userId}/password', authenticated: true },
  { method: 'DELETE', path: '/admin/users/{userId}', authenticated: true },
  { method: 'GET', path: '/admin/stats', authenticated: true },
  { method: 'GET', path: '/admin/articles', authenticated: true },
  { method: 'PUT', path: '/admin/settings', authenticated: true },
  { method: 'GET', path: '/admin/backup', authenticated: true },
  { method: 'POST', path: '/admin/backup/restore', authenticated: true, maxBodyBytes: backupMaxBodyBytes },
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

const bodyLimits = new Map(compiled.map((route) => [route.routeKey, route.maxBodyBytes ?? defaultMaxBodyBytes]));

/** The largest request body accepted for a route key. */
export function maxBodyBytes(routeKey: string) {
  return bodyLimits.get(routeKey) ?? defaultMaxBodyBytes;
}

export interface RouteMatch {
  routeKey: string;
  pathParameters: Record<string, string>;
  authenticated: boolean;
}

export function matchRoute(method: string, pathname: string): RouteMatch | null {
  for (const route of compiled) {
    if (route.method !== method) continue;
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    const pathParameters = Object.fromEntries(route.names.map((name, index) => [name, match[index + 1]]));
    return { routeKey: route.routeKey, pathParameters, authenticated: route.authenticated };
  }
  return null;
}
