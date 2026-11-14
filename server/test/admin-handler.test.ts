import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { createAdminRequestHandler } from '../admin-handler.js';
import type { Actor } from '../domain.js';
import type { ApiRequest } from '../routes.js';
import { assertMatches, fakeDatabase, match, respond, testContext } from './helpers.js';

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

function body(response: { body?: string | Buffer }) {
  return JSON.parse(String(response.body)) as Record<string, unknown>;
}

describe('admin request dispatch', () => {
  afterEach(() => {
    database.connect.mock.resetCalls();
    database.query.mock.resetCalls();
  });

  it('refuses every admin route without an Admin session, even with a Moderator actor', async () => {
    const moderator: Actor = { sub: 'moderator-sub', role: 'Moderator', displayName: 'Moderator' };
    for (const routeKey of ['GET /admin/users', 'GET /admin/stats', 'PUT /admin/settings', 'GET /admin/backup', 'POST /admin/backup/restore']) {
      const response = await handleAdminRequest(adminRequest({ routeKey, admin: null, actor: moderator, body: '{}' }));
      assert.equal(response.statusCode, 401, routeKey);
    }
    assert.equal((database.connect).mock.callCount(), 0);
    assert.equal((database.query).mock.callCount(), 0);
  });

  it('only creates Editor and Moderator accounts', async () => {
    const response = await handleAdminRequest(adminRequest({
      routeKey: 'POST /admin/users',
      body: JSON.stringify({ username: 'second', displayName: 'Second', role: 'Admin', password: 'Permanent123!' }),
    }));
    assert.equal(response.statusCode, 400);
    assertMatches(body(response), { code: 'VALIDATION_ERROR' });
    assert.equal((database.connect).mock.callCount(), 0);
  });

  it('rejects settings the configuration file defines with 409, naming the key', async () => {
    const response = await handleAdminRequest(adminRequest({
      routeKey: 'PUT /admin/settings',
      body: JSON.stringify({ version: 1, applicationName: 'Dashboard Archive' }),
    }), 'site:\n  applicationName: File Archive\n');
    assert.equal(response.statusCode, 409);
    assertMatches(body(response), { code: 'SETTING_DEFINED_IN_FILE', message: match.stringContaining('site.applicationName') });
    assert.equal((database.connect).mock.callCount(), 0);
  });

  it('requires a preview or restore action and an archive before reading the backup', async () => {
    const missingAction = await handleAdminRequest(adminRequest({ routeKey: 'POST /admin/backup/restore', rawBody: Buffer.from('PK') }));
    assert.equal(missingAction.statusCode, 400);
    assertMatches(body(missingAction), { code: 'INVALID_ACTION' });
    const missingArchive = await handleAdminRequest(adminRequest({ routeKey: 'POST /admin/backup/restore', query: { action: 'preview' } }));
    assert.equal(missingArchive.statusCode, 400);
    assert.equal((database.connect).mock.callCount(), 0);
  });

  it('validates user ids before accessing persistence', async () => {
    const response = await handleAdminRequest(adminRequest({ routeKey: 'DELETE /admin/users/{userId}', pathParameters: { userId: 'nope' } }));
    assert.equal(response.statusCode, 400);
    assertMatches(body(response), { code: 'INVALID_USER_ID' });
  });
});
