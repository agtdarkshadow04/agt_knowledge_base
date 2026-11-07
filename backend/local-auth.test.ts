// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ query: vi.fn() }));
const config = vi.hoisted(() => ({ ttlHours: 12 }));

vi.mock('./config.js', () => ({ getConfig: () => ({ session: { ttlHours: config.ttlHours } }) }));

vi.mock('./db.js', () => ({
  getPool: vi.fn(async () => database),
}));

import {
  authenticateLocalUser,
  hashPassword,
  issueLocalToken,
  verifyLocalToken,
  verifyPassword,
} from './local-auth.js';

describe('local authentication', () => {
  afterEach(() => {
    delete process.env.LOCAL_AUTH_SECRET;
    config.ttlHours = 12;
    database.query.mockReset();
  });

  it('hashes and verifies passwords without storing plaintext', async () => {
    const encoded = await hashPassword('Permanent123!');

    expect(encoded).toMatch(/^scrypt\$/);
    expect(encoded).not.toContain('Permanent123!');
    await expect(verifyPassword('Permanent123!', encoded)).resolves.toBe(true);
    await expect(verifyPassword('WrongPassword1!', encoded)).resolves.toBe(false);
    await expect(verifyPassword('Permanent123!', 'invalid')).resolves.toBe(false);
  });

  it('signs and verifies versioned local sessions against the active database user', async () => {
    process.env.LOCAL_AUTH_SECRET = 'a-secure-local-auth-secret-with-32-chars';
    const user = {
      sub: '10000000-0000-4000-8000-000000000001',
      username: 'traveller',
      displayName: 'Traveller',
      email: 'traveller@example.com',
      role: 'Moderator' as const,
      sessionVersion: 3,
    };
    database.query.mockResolvedValue({ rows: [{
      id: user.sub,
      username: user.username,
      password_hash: 'not-returned',
      display_name: user.displayName,
      email: user.email,
      role: user.role,
      session_version: 3,
    }] });
    const token = issueLocalToken(user);

    await expect(verifyLocalToken(token)).resolves.toEqual(user);
    // Change the signature's first character: it carries six full bits, unlike the final
    // character, whose low bits are ignored when decoding and can leave the bytes unchanged.
    const signatureStart = token.lastIndexOf('.') + 1;
    const tampered = `${token.slice(0, signatureStart)}${token[signatureStart] === 'A' ? 'B' : 'A'}${token.slice(signatureStart + 1)}`;
    await expect(verifyLocalToken(tampered)).rejects.toThrow('Invalid session token.');
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining('session_version = $2'), [user.sub, 3]);
  });

  it('authenticates active database users by normalized username', async () => {
    const passwordHash = await hashPassword('Permanent123!');
    database.query.mockResolvedValue({ rows: [{
      id: '10000000-0000-4000-8000-000000000001',
      username: 'traveller',
      password_hash: passwordHash,
      display_name: 'Traveller',
      email: 'traveller@example.com',
      role: 'Editor',
      session_version: 1,
    }] });

    await expect(authenticateLocalUser(' Traveller ', 'Permanent123!')).resolves.toEqual({
      sub: '10000000-0000-4000-8000-000000000001',
      username: 'traveller',
      displayName: 'Traveller',
      email: 'traveller@example.com',
      role: 'Editor',
      sessionVersion: 1,
    });
    expect(database.query).toHaveBeenCalledWith(expect.stringContaining('is_active = true'), ['traveller']);
    await expect(authenticateLocalUser('traveller', 'WrongPassword1!')).resolves.toBeNull();
  });

  it('requires a sufficiently strong session secret', () => {
    process.env.LOCAL_AUTH_SECRET = 'short';
    expect(() => issueLocalToken({
      sub: 'user-id',
      username: 'traveller',
      displayName: 'Traveller',
      role: 'Editor',
      sessionVersion: 1,
    })).toThrow('LOCAL_AUTH_SECRET must contain at least 32 characters.');
  });

  it('rejects tokens that carry a pre-migration role or the removed super-admin flag', async () => {
    process.env.LOCAL_AUTH_SECRET = 'a-secure-local-auth-secret-with-32-chars';
    const legacy = issueLocalToken({
      sub: 'user-id',
      username: 'atlas',
      displayName: 'Atlas',
      role: 'Admin' as never,
      sessionVersion: 1,
    });
    await expect(verifyLocalToken(legacy)).rejects.toThrow('Invalid session token.');
    expect(database.query).not.toHaveBeenCalled();
  });

  it('issues member tokens for the configured session lifetime', () => {
    process.env.LOCAL_AUTH_SECRET = 'a-secure-local-auth-secret-with-32-chars';
    config.ttlHours = 2;
    const token = issueLocalToken({ sub: 'user-id', username: 'apollo', displayName: 'Apollo', role: 'Editor', sessionVersion: 1 });
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8')) as { iat: number; exp: number };
    expect(payload.exp - payload.iat).toBe(2 * 60 * 60);
    expect(payload).not.toHaveProperty('isSuperAdmin');
  });
});
