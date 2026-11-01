// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { matchRoute, routeKeys } from './routes.js';

// Routes answered by the HTTP server itself rather than by handleRequest.
const serverRoutes = ['POST /auth/login', 'GET /auth/session', 'GET /setup/status', 'POST /setup'];

const articleId = '00000000-0000-4000-8000-000000000001';
const tagId = '10000000-0000-4000-8000-000000000001';

describe('route table', () => {
  it('matches literal and parameterized routes and extracts path parameters', () => {
    expect(matchRoute('GET', '/articles')).toEqual({ routeKey: 'GET /articles', pathParameters: {}, authenticated: false });
    expect(matchRoute('POST', `/articles/${articleId}/revisions/4/restore`)).toEqual({
      routeKey: 'POST /articles/{id}/revisions/{version}/restore',
      pathParameters: { id: articleId, version: '4' },
      authenticated: true,
    });
    expect(matchRoute('DELETE', `/articles/${articleId}/orphan-tags/${tagId}`)).toMatchObject({
      routeKey: 'DELETE /articles/{id}/orphan-tags/{tagId}',
      pathParameters: { id: articleId, tagId },
    });
    expect(matchRoute('PUT', '/admin/users/abc/password')).toMatchObject({
      routeKey: 'PUT /admin/users/{userId}/password',
      pathParameters: { userId: 'abc' },
    });
  });

  it('prefers literal paths over parameterized ones', () => {
    expect(matchRoute('GET', '/tags/orphans')).toMatchObject({ routeKey: 'GET /tags/orphans', pathParameters: {} });
    expect(matchRoute('PUT', '/tags/orphans')).toMatchObject({ routeKey: 'PUT /tags/{tagId}', pathParameters: { tagId: 'orphans' } });
  });

  it('keeps public reads public and requires authentication everywhere else', () => {
    const publicRoutes = [
      ['POST', '/auth/login'],
      ['GET', '/setup/status'],
      ['POST', '/setup'],
      ['GET', '/settings'],
      ['GET', '/articles'],
      ['GET', `/articles/${articleId}`],
      ['GET', '/tags'],
    ];
    for (const [method, path] of publicRoutes) expect(matchRoute(method, path)?.authenticated).toBe(false);

    const protectedRoutes = [
      ['GET', '/auth/session'],
      ['POST', '/articles'],
      ['PUT', `/articles/${articleId}`],
      ['DELETE', `/articles/${articleId}`],
      ['GET', `/articles/${articleId}/revisions`],
      ['PATCH', `/articles/${articleId}/protection`],
      ['GET', '/member/articles'],
      ['GET', `/member/articles/${articleId}`],
      ['GET', '/member/tags'],
      ['GET', '/tags/orphans'],
      ['POST', '/tags'],
      ['GET', '/admin/users'],
      ['GET', '/admin/stats'],
      ['PUT', '/admin/settings'],
    ];
    for (const [method, path] of protectedRoutes) expect(matchRoute(method, path)?.authenticated).toBe(true);
  });

  it('returns null for unknown paths, unsupported methods, and extra segments', () => {
    expect(matchRoute('GET', '/unknown')).toBeNull();
    expect(matchRoute('PATCH', `/articles/${articleId}`)).toBeNull();
    expect(matchRoute('GET', `/articles/${articleId}/extra/segments`)).toBeNull();
    expect(matchRoute('GET', '/articles/')).toBeNull();
  });

  it('declares exactly the routes the handler dispatches', () => {
    const source = readFileSync(new URL('./handler.ts', import.meta.url), 'utf8');
    const handled = [...source.matchAll(/case '([A-Z]+ [^']+)':/g)].map((match) => match[1]).sort();
    expect(new Set(routeKeys).size).toBe(routeKeys.length);
    expect(routeKeys.filter((key) => !serverRoutes.includes(key)).sort()).toEqual(handled);
  });
});
