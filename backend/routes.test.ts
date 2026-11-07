// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultMaxBodyBytes, isAdminPath, matchRoute, maxBodyBytes, routeKeys, usesBackupBodyLimit } from './routes.js';

// Routes answered by the HTTP server (server.ts) itself rather than by a handler.
const serverRoutes = [
  'POST /auth/login',
  'GET /auth/session',
  'GET /admin/setup/status',
  'POST /admin/setup',
  'POST /admin/auth/login',
  'POST /admin/auth/logout',
  'GET /admin/auth/session',
  'PUT /admin/auth/password',
];

const articleId = '00000000-0000-4000-8000-000000000001';
const tagId = '10000000-0000-4000-8000-000000000001';

function handledRoutes(file: string) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  return [...source.matchAll(/case '([A-Z]+ [^']+)':/g)].map((match) => match[1]);
}

describe('route table', () => {
  it('matches literal and parameterized routes and extracts path parameters', () => {
    expect(matchRoute('GET', '/articles')).toEqual({ routeKey: 'GET /articles', pathParameters: {}, auth: 'none', rawBody: false });
    expect(matchRoute('POST', `/articles/${articleId}/revisions/4/restore`)).toEqual({
      routeKey: 'POST /articles/{id}/revisions/{version}/restore',
      pathParameters: { id: articleId, version: '4' },
      auth: 'member',
      rawBody: false,
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
      ['GET', '/settings'],
      ['GET', '/articles'],
      ['GET', `/articles/${articleId}`],
      ['GET', '/tags'],
      ['GET', '/admin/setup/status'],
      ['POST', '/admin/setup'],
      ['POST', '/admin/auth/login'],
    ];
    for (const [method, path] of publicRoutes) expect(matchRoute(method, path)?.auth).toBe('none');

    const memberRoutes = [
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
    ];
    for (const [method, path] of memberRoutes) expect(matchRoute(method, path)?.auth).toBe('member');
  });

  it('puts every admin route behind the Admin session except setup and sign-in', () => {
    const adminKeys = routeKeys.filter((key) => isAdminPath(key.split(' ')[1]));
    const open = ['GET /admin/setup/status', 'POST /admin/setup', 'POST /admin/auth/login'];
    expect(adminKeys.length).toBeGreaterThan(10);
    for (const key of adminKeys) {
      const [method, path] = key.split(' ');
      const concrete = path.replace(/\{[^}]+\}/g, articleId);
      expect(matchRoute(method, concrete)?.auth, key).toBe(open.includes(key) ? 'none' : 'admin');
    }
    // No member route lives under /admin, and no admin route outside it.
    for (const key of routeKeys) {
      const route = matchRoute(key.split(' ')[0], key.split(' ')[1].replace(/\{[^}]+\}/g, articleId))!;
      if (route.auth === 'admin') expect(isAdminPath(key.split(' ')[1])).toBe(true);
      if (route.auth === 'member') expect(isAdminPath(key.split(' ')[1])).toBe(false);
    }
  });

  it('rate-limits member sign-in, Admin sign-in, setup, and Admin password changes', () => {
    expect(matchRoute('POST', '/auth/login')?.rateLimit).toBe('login');
    expect(matchRoute('POST', '/admin/auth/login')?.rateLimit).toBe('adminLogin');
    expect(matchRoute('POST', '/admin/setup')?.rateLimit).toBe('setup');
    expect(matchRoute('PUT', '/admin/auth/password')?.rateLimit).toBe('adminPassword');
  });

  it('takes the restore body limit from the effective backup.maxBytes setting', () => {
    expect(usesBackupBodyLimit('POST /admin/backup/restore')).toBe(true);
    expect(matchRoute('POST', '/admin/backup/restore')?.rawBody).toBe(true);
    expect(maxBodyBytes('POST /admin/backup/restore', 5_000_000)).toBe(5_000_000);
    expect(() => maxBodyBytes('POST /admin/backup/restore')).toThrow();
    for (const key of routeKeys.filter((routeKey) => routeKey !== 'POST /admin/backup/restore')) {
      expect(maxBodyBytes(key)).toBe(defaultMaxBodyBytes);
      expect(usesBackupBodyLimit(key)).toBe(false);
    }
    expect(maxBodyBytes('GET /unknown')).toBe(defaultMaxBodyBytes);
  });

  it('returns null for unknown paths, unsupported methods, and extra segments', () => {
    expect(matchRoute('GET', '/unknown')).toBeNull();
    expect(matchRoute('PATCH', `/articles/${articleId}`)).toBeNull();
    expect(matchRoute('GET', `/articles/${articleId}/extra/segments`)).toBeNull();
    expect(matchRoute('GET', '/articles/')).toBeNull();
    expect(matchRoute('GET', '/setup/status')).toBeNull();
    expect(matchRoute('POST', '/setup')).toBeNull();
  });

  it('declares exactly the routes the handlers dispatch', () => {
    const member = handledRoutes('./handler.ts');
    const admin = handledRoutes('./admin-handler.ts');
    expect(new Set(routeKeys).size).toBe(routeKeys.length);
    expect(member.every((key) => !isAdminPath(key.split(' ')[1]))).toBe(true);
    expect(admin.every((key) => isAdminPath(key.split(' ')[1]))).toBe(true);
    expect(routeKeys.filter((key) => !serverRoutes.includes(key)).sort()).toEqual([...member, ...admin].sort());
    const served = handledRoutes('./server.ts');
    expect(served.sort()).toEqual([...serverRoutes].sort());
  });
});
