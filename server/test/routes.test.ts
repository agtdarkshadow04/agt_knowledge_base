import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { buildApp } from '../app.js';
import { apiRoutes, routeKeys } from '../routes.js';
import { assertMatches, fakeDatabase, testContext } from './helpers.js';

// Routes answered by the app (app.ts) itself rather than by a handler.
const serverRoutes = [
  'GET /api/health',
  'POST /api/auth/login',
  'GET /api/auth/session',
  'GET /api/setup/status',
  'POST /api/setup',
  'POST /api/admin/login',
  'POST /api/admin/logout',
  'GET /api/admin/session',
  'POST /api/admin/password',
];

const articleId = '00000000-0000-4000-8000-000000000001';
const tagId = '10000000-0000-4000-8000-000000000001';

function handledRoutes(file: string) {
  const source = readFileSync(file, 'utf8');
  return [...source.matchAll(/case '([A-Z]+ [^']+)':/g)].map((found) => found[1]);
}

interface Routed {
  status: number;
  routeKey: string | undefined;
  params: Record<string, string>;
  body: Record<string, unknown>;
}

/**
 * Sends an unauthenticated request through the real Fastify app and reports
 * which route-table entry it matched and how the app answered. Handlers are
 * replaced by stubs and the database answers every query with no rows.
 */
async function route(method: string, url: string): Promise<Routed> {
  const pool = { query: async () => ({ rows: [], rowCount: 0 }) };
  const handler = async () => ({ statusCode: 200, headers: { 'content-type': 'application/json' }, body: '{}' });
  const app = buildApp(testContext({ db: fakeDatabase(pool) }), { handlers: { request: handler, admin: handler } });
  let matched: Pick<Routed, 'routeKey' | 'params'> = { routeKey: undefined, params: {} };
  app.addHook('onResponse', async (request) => {
    matched = { routeKey: request.routeOptions.config.apiRoute?.routeKey, params: { ...(request.params as Record<string, string>) } };
  });
  try {
    const response = await app.inject({ method: method as 'GET', url, headers: { 'x-agt-request': '1' } });
    return { status: response.statusCode, ...matched, body: response.body ? JSON.parse(response.body) as Record<string, unknown> : {} };
  } finally {
    await app.close();
  }
}

describe('route table', () => {
  it('matches literal and parameterized routes and extracts path parameters', async () => {
    assertMatches(await route('GET', '/api/articles'), { routeKey: 'GET /api/articles', params: {} });
    assertMatches(await route('POST', `/api/articles/${articleId}/revisions/4/restore`), {
      routeKey: 'POST /api/articles/{id}/revisions/{version}/restore',
      params: { id: articleId, version: '4' },
    });
    assertMatches(await route('DELETE', `/api/articles/${articleId}/orphan-tags/${tagId}`), {
      routeKey: 'DELETE /api/articles/{id}/orphan-tags/{tagId}',
      params: { id: articleId, tagId },
    });
    assertMatches(await route('PUT', '/api/admin/users/abc/password'), {
      routeKey: 'PUT /api/admin/users/{userId}/password',
      params: { userId: 'abc' },
    });
  });

  it('prefers literal paths over parameterized ones', async () => {
    assertMatches(await route('GET', '/api/tags/orphans'), { routeKey: 'GET /api/tags/orphans', params: {} });
    assertMatches(await route('PUT', '/api/tags/orphans'), { routeKey: 'PUT /api/tags/{tagId}', params: { tagId: 'orphans' } });
  });

  it('keeps public reads public and requires authentication everywhere else', async () => {
    const publicRoutes = [
      ['POST', '/api/auth/login'],
      ['GET', '/api/settings/public'],
      ['GET', '/api/settings'],
      ['GET', '/api/articles'],
      ['GET', `/api/articles/${articleId}`],
      ['GET', '/api/tags'],
      ['GET', '/api/admin/setup/status'],
      ['POST', '/api/admin/setup'],
      ['POST', '/api/admin/auth/login'],
    ];
    for (const [method, path] of publicRoutes) {
      const routed = await route(method, path);
      assert.ok(routed.routeKey, `${method} ${path}`);
      assert.notEqual(routed.status, 401, `${method} ${path}`);
    }

    const memberRoutes = [
      ['GET', '/api/auth/session'],
      ['POST', '/api/articles'],
      ['PUT', `/api/articles/${articleId}`],
      ['DELETE', `/api/articles/${articleId}`],
      ['GET', `/api/articles/${articleId}/revisions`],
      ['PATCH', `/api/articles/${articleId}/protection`],
      ['GET', '/api/member/articles'],
      ['GET', `/api/member/articles/${articleId}`],
      ['GET', '/api/member/tags'],
      ['GET', '/api/tags/orphans'],
      ['POST', '/api/tags'],
    ];
    for (const [method, path] of memberRoutes) {
      assertMatches(await route(method, path), { status: 401, body: { error: 'unauthorized', code: 'UNAUTHENTICATED', message: 'Authentication is required.' } });
    }
  });

  it('puts every admin route behind the Admin session except setup and sign-in', async () => {
    const adminKeys = apiRoutes.filter((candidate) => candidate.admin).map((candidate) => candidate.routeKey);
    const open = ['GET /api/admin/setup/status', 'POST /api/admin/setup', 'POST /api/admin/auth/login', 'POST /api/admin/login'];
    assert.ok(adminKeys.length > 10);
    for (const key of adminKeys) {
      const [method, path] = key.split(' ');
      const routed = await route(method, path.replace(/\{[^}]+\}/g, articleId));
      assert.equal(routed.routeKey, key);
      if (open.includes(key)) assert.notEqual(routed.status, 401, key);
      else assertMatches(routed, { status: 401, body: { error: 'unauthorized', code: 'UNAUTHENTICATED', message: 'Admin sign-in is required.' } });
    }
    // No member route lives under /admin, and no admin route outside it.
    for (const entry of apiRoutes) {
      if (entry.auth === 'admin') assert.equal(entry.admin, true, entry.routeKey);
      if (entry.auth === 'member') assert.equal(entry.admin, false, entry.routeKey);
    }
  });

  it('rate-limits member sign-in, Admin sign-in, setup, Admin password changes and backup uploads', () => {
    const rateLimit = (key: string) => apiRoutes.find((entry) => entry.routeKey === key)?.rateLimit;
    assert.equal(rateLimit('POST /api/auth/login'), 'login');
    assert.equal(rateLimit('POST /api/admin/login'), 'adminLogin');
    assert.equal(rateLimit('POST /api/setup'), 'setup');
    assert.equal(rateLimit('POST /api/admin/password'), 'adminPassword');
    assert.equal(rateLimit('POST /api/admin/backup/restore'), 'adminUploads');
    // Each deprecated path shares its replacement's limit.
    assert.equal(rateLimit('POST /api/admin/auth/login'), 'adminLogin');
    assert.equal(rateLimit('POST /api/admin/setup'), 'setup');
    assert.equal(rateLimit('PUT /api/admin/auth/password'), 'adminPassword');
    assert.deepEqual(apiRoutes.filter((entry) => entry.rateLimit).map((entry) => entry.routeKey).sort(), [
      'POST /api/admin/auth/login',
      'POST /api/admin/backup/restore',
      'POST /api/admin/login',
      'POST /api/admin/password',
      'POST /api/admin/setup',
      'POST /api/auth/login',
      'POST /api/setup',
      'PUT /api/admin/auth/password',
    ]);
  });

  it('takes the restore body limit from the effective backup.maxBytes setting', () => {
    const restore = apiRoutes.find((entry) => entry.routeKey === 'POST /api/admin/backup/restore');
    assertMatches(restore, { maxBodyBytes: 'backup', rawBody: true });
    for (const entry of apiRoutes.filter((candidate) => candidate !== restore)) {
      assert.equal(entry.maxBodyBytes, undefined, entry.routeKey);
      assert.equal(entry.rawBody, undefined, entry.routeKey);
    }
  });

  it('answers unknown paths, unsupported methods, and extra segments with 404', async () => {
    for (const [method, path] of [
      ['GET', '/api/unknown'],
      ['PATCH', `/api/articles/${articleId}`],
      ['GET', `/api/articles/${articleId}/extra/segments`],
      ['GET', '/api/articles/'],
      ['GET', '/articles'],
      ['GET', '/admin/stats'],
    ]) {
      assertMatches(await route(method, path), { status: 404, body: { error: 'not_found', code: 'NOT_FOUND', message: 'Route not found.' } });
    }
  });

  it('declares exactly the routes the handlers dispatch', () => {
    const member = handledRoutes('server/handler.ts');
    const admin = handledRoutes('server/admin-handler.ts');
    const isAdmin = (key: string) => apiRoutes.find((entry) => entry.routeKey === key)?.admin;
    assert.equal(new Set(routeKeys).size, routeKeys.length);
    assert.equal(member.every((key) => isAdmin(key) === false), true);
    assert.equal(admin.every((key) => isAdmin(key) === true), true);
    const canonical = apiRoutes.filter((entry) => !entry.replacedBy || entry.ownHandler).map((entry) => entry.routeKey);
    assert.deepEqual(canonical.filter((key) => !serverRoutes.includes(key)).sort(), [...member, ...admin].sort());
    const served = handledRoutes('server/app.ts');
    assert.deepEqual(served.sort(), [...serverRoutes].sort());
    // A deprecated path is served by the handler of its replacement, unless its response differs (ownHandler).
    for (const entry of apiRoutes.filter((candidate) => candidate.replacedBy)) {
      assert.equal(entry.handlerKey, entry.ownHandler ? entry.routeKey : entry.replacedBy, entry.routeKey);
    }
  });
});
