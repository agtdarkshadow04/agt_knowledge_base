// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ query: vi.fn() }));

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
    delete process.env.LOCAL_AUTH_SESSION_HOURS;
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

  it('signs and verifies expiring local sessions', () => {
    process.env.LOCAL_AUTH_SECRET = 'a-secure-local-auth-secret-with-32-chars';
    const user = {
      sub: '10000000-0000-4000-8000-000000000001',
      username: 'traveller',
      displayName: 'Traveller',
      email: 'traveller@example.com',
      role: 'Admin' as const,
    };
    const token = issueLocalToken(user);

    expect(verifyLocalToken(token)).toEqual(user);
    expect(() => verifyLocalToken(`${token.slice(0, -1)}x`)).toThrow('Invalid session token.');
  });

  it('authenticates active database users by normalized username', async () => {
    const passwordHash = await hashPassword('Permanent123!');
    database.query.mockResolvedValue({ rows: [{
      id: '10000000-0000-4000-8000-000000000001',
      username: 'traveller',
      password_hash: passwordHash,
      display_name: 'Traveller',
      email: 'traveller@example.com',
      role: 'Standard',
    }] });

    await expect(authenticateLocalUser(' Traveller ', 'Permanent123!')).resolves.toEqual({
      sub: '10000000-0000-4000-8000-000000000001',
      username: 'traveller',
      displayName: 'Traveller',
      email: 'traveller@example.com',
      role: 'Standard',
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
      role: 'Standard',
    })).toThrow('LOCAL_AUTH_SECRET must contain at least 32 characters.');
  });
});
