import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { createAdminRequestHandler } from '../adminRoutes.js';
import type { Actor } from '../domain.js';
import type { ApiRequest } from '../routes.js';
import { assertMatches, fakeDatabase, respond, testContext, testLogs } from './helpers.js';

const database = {
  connect: mock.fn(async (): Promise<unknown> => undefined),
  query: mock.fn(async (): Promise<unknown> => undefined),
};

function handleAdminRequest(request: ApiRequest, config = '') {
  return respond(createAdminRequestHandler(testContext({ config, db: fakeDatabase(database) })), request);
}

const admin = { username: 'atlas' };

function adminRequest(input: Partial<ApiRequest> & Pick<ApiRequest, 'routeKey'>): ApiRequest {
  return { pathParameters: {}, query: {}, actor: null, admin, requestId: 'request-id', ...input };
}

function body(response: { body?: unknown }) {
  return response.body as Record<string, unknown>;
}

describe('admin request dispatch', () => {
  afterEach(() => {
    database.connect.mock.resetCalls();
    database.query.mock.resetCalls();
  });

  it('refuses every admin route without an Admin session, even with a Moderator actor', async () => {
    const moderator: Actor = { sub: 'moderator-sub', role: 'Moderator', displayName: 'Moderator' };
    for (const routeKey of ['GET /api/admin/users', 'GET /api/admin/stats', 'PUT /api/admin/settings', 'GET /api/admin/backup', 'POST /api/admin/backup/restore']) {
      const response = await handleAdminRequest(adminRequest({ routeKey, admin: null, actor: moderator, body: {} }));
      assert.equal(response.statusCode, 401, routeKey);
    }
    assert.equal((database.connect).mock.callCount(), 0);
    assert.equal((database.query).mock.callCount(), 0);
  });

  it('only creates Editor and Moderator accounts', async () => {
    const response = await handleAdminRequest(adminRequest({
      routeKey: 'POST /api/admin/users',
      body: { username: 'second', displayName: 'Second', role: 'Admin', password: 'Permanent123!' },
    }));
    assert.equal(response.statusCode, 400);
    assertMatches(body(response), { error: 'validation_failed', code: 'VALIDATION_ERROR' });
    assert.equal((database.connect).mock.callCount(), 0);
  });

  it('rejects settings the configuration file defines with 409, naming the key', async () => {
    const response = await handleAdminRequest(adminRequest({
      routeKey: 'PUT /api/admin/settings',
      body: { values: { 'site.title': 'Dashboard Archive' } },
    }), 'site:\n  title: File Archive\n');
    assert.equal(response.statusCode, 409);
    assertMatches(body(response), {
      error: 'defined_in_config',
      code: 'SETTING_DEFINED_IN_FILE',
      message: 'site.title is defined in the configuration file and cannot be changed from the dashboard.',
      params: { key: 'site.title' },
    });
    assert.equal((database.connect).mock.callCount(), 0);
  });

  it('requires a preview or restore action and an archive before reading the backup', async () => {
    const missingAction = await handleAdminRequest(adminRequest({ routeKey: 'POST /api/admin/restore', upload: { action: '', file: '/nonexistent' } }));
    assert.equal(missingAction.statusCode, 400);
    assertMatches(body(missingAction), { error: 'validation_failed', code: 'INVALID_ACTION', fields: [{ field: 'action' }] });
    const missingArchive = await handleAdminRequest(adminRequest({ routeKey: 'POST /api/admin/restore' }));
    assert.equal(missingArchive.statusCode, 400);
    assert.equal((database.connect).mock.callCount(), 0);
  });

  it('answers a malformed user id with 404 before accessing persistence (API-5)', async () => {
    const response = await handleAdminRequest(adminRequest({ routeKey: 'DELETE /api/admin/users/{userId}', pathParameters: { userId: 'nope' } }));
    assert.equal(response.statusCode, 404);
    assertMatches(body(response), { error: 'not_found', code: 'INVALID_USER_ID' });
  });
});

describe('log routes (LOG-18, LOG-20, LOG-22)', () => {
  const entries = Array.from({ length: 3 }, (_, index) => ({
    id: `10000000-0000-4000-8000-00000000000${index}`,
    at: new Date(Date.UTC(2026, 10, 16, 1, 0, 3 - index)),
    level: 'warn' as const,
    source: 'config',
    message: `entry ${index}`,
    requestId: null,
    details: {},
  }));

  it('pages the server log newest first, with an opaque cursor, and refuses a malformed one', async () => {
    const logs = testLogs(entries);
    const handler = createAdminRequestHandler(testContext({ logs }));
    const first = await respond(handler, adminRequest({ routeKey: 'GET /api/admin/logs/server', query: { limit: '2', level: 'warn' } }));
    assert.equal(first.statusCode, 200);
    const page = body(first) as { items: Array<{ message: string }>; nextCursor: string };
    assert.deepEqual(page.items.map((item) => item.message), ['entry 0', 'entry 1']);
    assert.equal(typeof page.nextCursor, 'string');
    const bad = await respond(handler, adminRequest({ routeKey: 'GET /api/admin/logs/audit', query: { cursor: 'nope' } }));
    assert.equal(bad.statusCode, 400);
    const badLevel = await respond(handler, adminRequest({ routeKey: 'GET /api/admin/logs/server', query: { level: 'debug' } }));
    assertMatches(body(badLevel), { error: 'validation_failed' });
  });

  it('streams an export with its file name and audits the filters, and clears only the server log', async () => {
    const logs = testLogs(entries);
    const handler = createAdminRequestHandler(testContext({ logs }));
    const exported = await handler(adminRequest({ routeKey: 'GET /api/admin/logs/server/export', query: { format: 'csv', source: 'config' } }));
    assert.equal(exported.headers['content-type'], 'text/csv; charset=utf-8');
    assert.match(exported.headers['content-disposition'], /^attachment; filename="agt-knowledge-base-server-log-.*\.csv"$/);
    assertMatches(exported.audit!, { details: { format: 'csv', filters: { source: 'config' } } });
    let csv = '';
    for await (const chunk of exported.body as AsyncIterable<unknown>) csv += String(chunk);
    assert.equal(csv.split('\r\n').length, 5);

    const cleared = await handler(adminRequest({ routeKey: 'DELETE /api/admin/logs/server' }));
    assert.equal(cleared.statusCode, 204);
    assertMatches(cleared.audit!, { details: { deleted: 3 } });
    assert.equal(logs.cleared, 1);
    const seen = await handler(adminRequest({ routeKey: 'POST /api/admin/logs/server/seen' }));
    assert.equal(seen.statusCode, 204);
    assert.equal(logs.seen, 1);
  });
});
