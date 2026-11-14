import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { createAdminRequestHandler } from '../admin-handler.js';
import type { Actor } from '../domain.js';
import type { ApiRequest } from '../routes.js';
import { assertMatches, fakeDatabase, respond, testContext } from './helpers.js';

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
    const missingAction = await handleAdminRequest(adminRequest({ routeKey: 'POST /api/admin/backup/restore', rawBody: Buffer.from('PK') }));
    assert.equal(missingAction.statusCode, 400);
    assertMatches(body(missingAction), { error: 'validation_failed', code: 'INVALID_ACTION' });
    const missingArchive = await handleAdminRequest(adminRequest({ routeKey: 'POST /api/admin/backup/restore', query: { action: 'preview' } }));
    assert.equal(missingArchive.statusCode, 400);
    assert.equal((database.connect).mock.callCount(), 0);
  });

  it('answers a malformed user id with 404 before accessing persistence (API-5)', async () => {
    const response = await handleAdminRequest(adminRequest({ routeKey: 'DELETE /api/admin/users/{userId}', pathParameters: { userId: 'nope' } }));
    assert.equal(response.statusCode, 404);
    assertMatches(body(response), { error: 'not_found', code: 'INVALID_USER_ID' });
  });
});
