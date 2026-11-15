import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { requireActor, requireAdminSession, toActor } from '../auth.js';
import type { Actor } from '../domain.js';
import { throwsMatching } from './helpers.js';

describe('authentication', () => {
  it('turns a signed-in member into an actor', () => {
    assert.deepEqual(toActor({
      sub: '00000000-0000-4000-8000-000000000001',
      username: 'traveller',
      displayName: 'Traveller',
      role: 'Moderator',
    }), {
      sub: '00000000-0000-4000-8000-000000000001',
      role: 'Moderator',
      displayName: 'Traveller',
      email: undefined,
    });
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
