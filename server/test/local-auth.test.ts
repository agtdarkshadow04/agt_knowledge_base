import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { parseConfig } from '../config.js';
import { assertLocalAuthSecret, hashPassword, LocalAuthService, verifyPassword } from '../local-auth.js';
import { assertCalledWith, fakeDatabase, match } from './helpers.js';

const database = { query: mock.fn(async (_sql: string, _params?: unknown[]): Promise<unknown> => undefined) };
const secret = 'a-secure-local-auth-secret-with-32-chars';

function localAuth(ttlHours = 12) {
  return new LocalAuthService({
    config: parseConfig(`session:\n  ttlHours: ${ttlHours}\n`),
    db: fakeDatabase(database),
    localAuthSecret: secret,
  });
}

describe('local authentication', () => {
  afterEach(() => {
    database.query.mock.restore();
    database.query.mock.resetCalls();
  });

  it('hashes and verifies passwords without storing plaintext', async () => {
    const encoded = await hashPassword('Permanent123!');

    assert.match(encoded, /^scrypt\$/);
    assert.ok(!(encoded).includes('Permanent123!'));
    assert.equal(await verifyPassword('Permanent123!', encoded), true);
    assert.equal(await verifyPassword('WrongPassword1!', encoded), false);
    assert.equal(await verifyPassword('Permanent123!', 'invalid'), false);
  });

  it('signs and verifies versioned local sessions against the active database user', async () => {
    const user = {
      sub: '10000000-0000-4000-8000-000000000001',
      username: 'traveller',
      displayName: 'Traveller',
      email: 'traveller@example.com',
      role: 'Moderator' as const,
      sessionVersion: 3,
    };
    database.query.mock.mockImplementation(async () => ({ rows: [{
      id: user.sub,
      username: user.username,
      password_hash: 'not-returned',
      display_name: user.displayName,
      email: user.email,
      role: user.role,
      session_version: 3,
    }] }));
    const token = localAuth().issueToken(user);

    assert.deepEqual(await localAuth().verifyToken(token), user);
    // Change the signature's first character: it carries six full bits, unlike the final
    // character, whose low bits are ignored when decoding and can leave the bytes unchanged.
    const signatureStart = token.lastIndexOf('.') + 1;
    const tampered = `${token.slice(0, signatureStart)}${token[signatureStart] === 'A' ? 'B' : 'A'}${token.slice(signatureStart + 1)}`;
    await assert.rejects(localAuth().verifyToken(tampered), /Invalid session token\./);
    assertCalledWith(database.query, match.stringContaining('session_version = $2'), [user.sub, 3]);
  });

  it('authenticates active database users by normalized username', async () => {
    const passwordHash = await hashPassword('Permanent123!');
    database.query.mock.mockImplementation(async () => ({ rows: [{
      id: '10000000-0000-4000-8000-000000000001',
      username: 'traveller',
      password_hash: passwordHash,
      display_name: 'Traveller',
      email: 'traveller@example.com',
      role: 'Editor',
      session_version: 1,
    }] }));

    assert.deepEqual(await localAuth().authenticate(' Traveller ', 'Permanent123!'), {
      sub: '10000000-0000-4000-8000-000000000001',
      username: 'traveller',
      displayName: 'Traveller',
      email: 'traveller@example.com',
      role: 'Editor',
      sessionVersion: 1,
    });
    assertCalledWith(database.query, match.stringContaining('is_active = true'), ['traveller']);
    assert.equal(await localAuth().authenticate('traveller', 'WrongPassword1!'), null);
  });

  it('requires a sufficiently strong session secret', () => {
    assert.throws(() => assertLocalAuthSecret('short'), /LOCAL_AUTH_SECRET must contain at least 32 characters\./);
    assert.throws(() => assertLocalAuthSecret(undefined), /LOCAL_AUTH_SECRET must contain at least 32 characters\./);
    assert.equal(assertLocalAuthSecret(secret), secret);
  });

  it('rejects tokens that carry a pre-migration role or the removed super-admin flag', async () => {
    const legacy = localAuth().issueToken({
      sub: 'user-id',
      username: 'atlas',
      displayName: 'Atlas',
      role: 'Admin' as never,
      sessionVersion: 1,
    });
    await assert.rejects(localAuth().verifyToken(legacy), /Invalid session token\./);
    assert.equal((database.query).mock.callCount(), 0);
  });

  it('issues member tokens for the configured session lifetime', () => {
    const token = localAuth(2).issueToken({ sub: 'user-id', username: 'apollo', displayName: 'Apollo', role: 'Editor', sessionVersion: 1 });
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { iat: number; exp: number };
    assert.equal(payload.exp - payload.iat, 2 * 60 * 60);
    assert.ok(!('isSuperAdmin' in payload));
  });
});
