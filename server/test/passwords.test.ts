import assert from 'node:assert/strict';
import { randomBytes, scrypt } from 'node:crypto';
import { describe, it } from 'node:test';
import { hashPassword, parseHash, SCRYPT_PROFILES, secretsEqual, verifyPassword } from '../passwords.js';

/** A 1.x hash (Node's default scrypt parameters, base64url) as migration 017 rewrites it. */
async function migratedLegacyHash(password: string) {
  const salt = randomBytes(16);
  const key = await new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, (error, derived) => (error ? reject(error) : resolve(derived)));
  });
  const migrated = (value: Buffer) => `${value.toString('base64url').replace(/-/g, '+').replace(/_/g, '/')}==`;
  return `scrypt$16384$8$1$${migrated(salt)}$${migrated(key)}`;
}

describe('password hashing (AUTH-2)', () => {
  it('stores scrypt$N$r$p$salt$hash with the fixed profile and verifies without storing plaintext', async () => {
    const stored = await hashPassword('Permanent123!');
    assert.match(stored, /^scrypt\$32768\$8\$1\$[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{86}==$/);
    assert.ok(!stored.includes('Permanent123!'));
    assert.deepEqual(await verifyPassword('Permanent123!', stored), { ok: true, rehash: false });
    assert.deepEqual(await verifyPassword('WrongPassword1!', stored), { ok: false, malformed: false });
    assert.deepEqual(SCRYPT_PROFILES[0], { N: 32768, r: 8, p: 1 });
  });

  it('normalizes the password with NFKC', async () => {
    const stored = await hashPassword('Ａbc-defg-hij1');
    assert.equal((await verifyPassword('Abc-defg-hij1', stored)).ok, true);
  });

  it('rejects a malformed or unsupported stored hash without calling scrypt', async () => {
    const good = await hashPassword('Permanent123!');
    const [, , , , salt, hash] = good.split('$');
    const malformed = [
      'invalid',
      'scrypt$salt$hash',
      `bcrypt$32768$8$1$${salt}$${hash}`,
      `scrypt$32768$8$1$${salt}$${hash}$extra`,
      `scrypt$65536$8$1$${salt}$${hash}`,
      `scrypt$032768$8$1$${salt}$${hash}`,
      `scrypt$+32768$8$1$${salt}$${hash}`,
      `scrypt$32768$8$2$${salt}$${hash}`,
      `scrypt$32768$8$1$${salt.slice(4)}$${hash}`,
      `scrypt$32768$8$1$${salt}$${hash.replace(/=+$/, '')}`,
      `scrypt$32768$8$1$${salt.replace(/[+/]/g, '-')}A$${hash}`,
      `scrypt$32768$8$1$${salt}$${hash.slice(0, -4)}AAAA`,
    ];
    for (const stored of malformed) {
      assert.equal(parseHash(stored), null, stored);
      const started = performance.now();
      assert.deepEqual(await verifyPassword('Permanent123!', stored), { ok: false, malformed: true }, stored);
      // scrypt with these parameters takes tens of milliseconds; a rejected format never calls it.
      assert.ok(performance.now() - started < 15, stored);
    }
  });

  it('verifies a migrated 1.x hash and asks for a rehash', async () => {
    const stored = await migratedLegacyHash('Permanent123!');
    assert.ok(parseHash(stored));
    assert.deepEqual(await verifyPassword('Permanent123!', stored), { ok: true, rehash: true });
    assert.deepEqual(await verifyPassword('Wrong-Password1', stored), { ok: false, malformed: false });
  });
});

describe('secretsEqual (AUTH-3)', () => {
  it('compares secrets of any length', () => {
    assert.equal(secretsEqual('setup-secret', 'setup-secret'), true);
    assert.equal(secretsEqual('setup-secret', 'setup-secreT'), false);
    assert.equal(secretsEqual('short', 'a much longer value'), false);
    assert.equal(secretsEqual('', ''), true);
  });
});
