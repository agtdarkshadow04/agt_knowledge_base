// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn() }));
vi.mock('./db.js', () => ({ getPool: vi.fn(async () => database) }));

import { handleAdminRequest } from './admin-handler.js';
import { parseConfig, setConfigForTests } from './config.js';
import type { Actor } from './domain.js';
import type { ApiRequest } from './routes.js';

const admin = { username: 'atlas' };

function adminRequest(input: Partial<ApiRequest> & Pick<ApiRequest, 'routeKey'>): ApiRequest {
  return { pathParameters: {}, query: {}, actor: null, admin, requestId: 'request-id', ...input };
}

function body(response: { body?: string | Buffer }) {
  return JSON.parse(String(response.body)) as Record<string, unknown>;
}

describe('admin request dispatch', () => {
  afterEach(() => {
    setConfigForTests(undefined);
    database.connect.mockReset();
    database.query.mockReset();
  });

  it('refuses every admin route without an Admin session, even with a Moderator actor', async () => {
    const moderator: Actor = { sub: 'moderator-sub', role: 'Moderator', displayName: 'Moderator' };
    for (const routeKey of ['GET /admin/users', 'GET /admin/stats', 'PUT /admin/settings', 'GET /admin/backup', 'POST /admin/backup/restore']) {
      const response = await handleAdminRequest(adminRequest({ routeKey, admin: null, actor: moderator, body: '{}' }));
      expect(response.statusCode, routeKey).toBe(401);
    }
    expect(database.connect).not.toHaveBeenCalled();
    expect(database.query).not.toHaveBeenCalled();
  });

  it('only creates Editor and Moderator accounts', async () => {
    const response = await handleAdminRequest(adminRequest({
      routeKey: 'POST /admin/users',
      body: JSON.stringify({ username: 'second', displayName: 'Second', role: 'Admin', password: 'Permanent123!' }),
    }));
    expect(response.statusCode).toBe(400);
    expect(body(response)).toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('rejects settings the configuration file defines with 409, naming the key', async () => {
    setConfigForTests({ path: '/app/config.yaml', text: 'site:\n  applicationName: File Archive\n', config: parseConfig('site:\n  applicationName: File Archive\n') });
    const response = await handleAdminRequest(adminRequest({
      routeKey: 'PUT /admin/settings',
      body: JSON.stringify({ version: 1, applicationName: 'Dashboard Archive' }),
    }));
    expect(response.statusCode).toBe(409);
    expect(body(response)).toMatchObject({ code: 'SETTING_DEFINED_IN_FILE', message: expect.stringContaining('site.applicationName') });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('requires a preview or restore action and an archive before reading the backup', async () => {
    const missingAction = await handleAdminRequest(adminRequest({ routeKey: 'POST /admin/backup/restore', rawBody: Buffer.from('PK') }));
    expect(missingAction.statusCode).toBe(400);
    expect(body(missingAction)).toMatchObject({ code: 'INVALID_ACTION' });
    const missingArchive = await handleAdminRequest(adminRequest({ routeKey: 'POST /admin/backup/restore', query: { action: 'preview' } }));
    expect(missingArchive.statusCode).toBe(400);
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('validates user ids before accessing persistence', async () => {
    const response = await handleAdminRequest(adminRequest({ routeKey: 'DELETE /admin/users/{userId}', pathParameters: { userId: 'nope' } }));
    expect(response.statusCode).toBe(400);
    expect(body(response)).toMatchObject({ code: 'INVALID_USER_ID' });
  });
});
