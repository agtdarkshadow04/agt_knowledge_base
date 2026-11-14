import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

const localAuth = { verifyToken: mock.fn(async (_token: string): Promise<LocalSessionUser> => { throw new Error('unused'); }) };

import { authenticate, requireActor, requireAdminSession, toActor } from '../auth.js';
import type { Actor } from '../domain.js';
import type { LocalSessionUser } from '../local-auth.js';
import { assertCalledWith, throwsMatching } from './helpers.js';

describe('authentication', () => {
  it('resolves a bearer token to the current user without exposing the session version', async () => {
    localAuth.verifyToken.mock.mockImplementationOnce(async () => ({
      sub: '00000000-0000-4000-8000-000000000001',
      username: 'traveller',
      displayName: 'Traveller',
      role: 'Moderator',
      sessionVersion: 3,
    }));
    const user = await authenticate(localAuth, 'token');
    assertCalledWith(localAuth.verifyToken, 'token');
    assert.deepEqual(user, {
      sub: '00000000-0000-4000-8000-000000000001',
      username: 'traveller',
      displayName: 'Traveller',
      email: undefined,
      role: 'Moderator',
    });
    assert.deepEqual(toActor(user), {
      sub: '00000000-0000-4000-8000-000000000001',
      role: 'Moderator',
      displayName: 'Traveller',
      email: undefined,
    });
  });

  it('rejects tokens the local session verifier rejects', async () => {
    localAuth.verifyToken.mock.mockImplementationOnce(async () => { throw new Error('Invalid session token.'); });
    await assert.rejects(authenticate(localAuth, 'forged'), /Invalid session token\./);
  });

  it('requires a signed-in actor, and an Admin session on admin routes', () => {
    const editor: Actor = { sub: 'editor-sub', role: 'Editor', displayName: 'Editor' };
    throwsMatching(() => requireActor({ actor: null }), { statusCode: 401 });
    assert.equal(requireActor({ actor: editor }), editor);
    throwsMatching(() => requireAdminSession({ admin: null }), { statusCode: 401 });
    throwsMatching(() => requireAdminSession({}), { statusCode: 401 });
    assert.deepEqual(requireAdminSession({ admin: { username: 'atlas' } }), { username: 'atlas' });
  });
});
