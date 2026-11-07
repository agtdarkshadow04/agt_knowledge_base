// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn() }));
vi.mock('./db.js', () => ({ getPool: vi.fn(async () => database) }));

const auth = vi.hoisted(() => ({ verifyPassword: vi.fn() }));
vi.mock('./local-auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./local-auth.js')>();
  auth.verifyPassword.mockImplementation(actual.verifyPassword);
  return { ...actual, verifyPassword: auth.verifyPassword };
});

import {
  AdminAuthService,
  constantTimeEqual,
  hashSessionToken,
  readCookie,
  sessionCookie,
} from './admin-auth.js';
import { dummyPasswordHash, hashPassword } from './local-auth.js';

const setupSecret = 'one-time-setup-secret';

type Query = ReturnType<typeof vi.fn>;

function useClient(handler: (sql: string, params?: unknown[]) => unknown) {
  const query: Query = vi.fn(async (sql: string, params?: unknown[]) => handler(sql, params) ?? { rowCount: 0, rows: [] });
  database.connect.mockResolvedValue({ query, release: vi.fn() });
  return query;
}

function statements(query: Query) {
  return query.mock.calls.map(([sql]) => sql as string);
}

describe('Admin setup', () => {
  beforeEach(() => { process.env.AGT_SETUP_PASSWORD = setupSecret; });
  afterEach(() => {
    delete process.env.AGT_SETUP_PASSWORD;
    database.connect.mockReset();
    database.query.mockReset();
  });

  const input = { setupPassword: setupSecret, username: 'atlas', password: 'Permanent123!' };

  it('is refused when AGT_SETUP_PASSWORD is unset', async () => {
    delete process.env.AGT_SETUP_PASSWORD;
    await expect(new AdminAuthService().setup(input)).rejects.toMatchObject({ statusCode: 403, code: 'SETUP_DISABLED' });
    expect(database.query).not.toHaveBeenCalled();
  });

  it('requires the setup password', async () => {
    database.query.mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(new AdminAuthService().setup({ ...input, setupPassword: 'guess' }))
      .rejects.toMatchObject({ statusCode: 401, code: 'INVALID_SETUP_PASSWORD' });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('rejects a new password equal to the setup password', async () => {
    database.query.mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(new AdminAuthService().setup({ ...input, password: setupSecret }))
      .rejects.toMatchObject({ statusCode: 400, code: 'PASSWORD_REUSED' });
  });

  it('fails once an Admin exists, even with the setup password', async () => {
    database.query.mockResolvedValue({ rowCount: 1, rows: [{}] });
    await expect(new AdminAuthService().setup(input)).rejects.toMatchObject({ statusCode: 409, code: 'SETUP_ALREADY_COMPLETED' });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('handles a concurrent setup that inserted the Admin first', async () => {
    database.query.mockResolvedValue({ rowCount: 0, rows: [] });
    const query = useClient((sql) => (sql.includes('INSERT INTO admin ') ? { rowCount: 0, rows: [] } : undefined));
    await expect(new AdminAuthService().setup(input)).rejects.toMatchObject({ statusCode: 409 });
    expect(statements(query)).toContain('ROLLBACK');
  });

  it('creates the Admin and a session, storing only the token hash', async () => {
    database.query.mockResolvedValue({ rowCount: 0, rows: [] });
    const query = useClient((sql) => (sql.includes('INSERT INTO admin ') ? { rowCount: 1, rows: [] } : undefined));

    const session = await new AdminAuthService().setup(input);

    expect(session.admin).toEqual({ username: 'atlas' });
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const adminInsert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO admin '))!;
    expect(adminInsert[1]).toEqual(['atlas', expect.stringMatching(/^scrypt\$/)]);
    const sessionInsert = query.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO admin_sessions'))!;
    expect(sessionInsert[1]).toEqual([hashSessionToken(session.token), session.expiresAt]);
    expect(JSON.stringify(query.mock.calls)).not.toContain(session.token);
    expect(statements(query)).toContain('COMMIT');
  });
});

describe('Admin sign-in and sessions', () => {
  afterEach(() => {
    database.connect.mockReset();
    database.query.mockReset();
    auth.verifyPassword.mockClear();
  });

  it('verifies against a dummy hash when no Admin exists', async () => {
    database.query.mockResolvedValue({ rowCount: 0, rows: [] });
    await expect(new AdminAuthService().login('atlas', 'Permanent123!')).rejects.toMatchObject({ statusCode: 401, code: 'INVALID_CREDENTIALS' });
    expect(auth.verifyPassword).toHaveBeenCalledWith('Permanent123!', await dummyPasswordHash());
  });

  it('requires both the username and the password, checking the password either way', async () => {
    const passwordHash = await hashPassword('Permanent123!');
    database.query.mockImplementation(async (sql: string) => (sql.startsWith('SELECT username')
      ? { rowCount: 1, rows: [{ username: 'atlas', password_hash: passwordHash }] }
      : { rowCount: 1, rows: [] }));

    await expect(new AdminAuthService().login('apollo', 'Permanent123!')).rejects.toMatchObject({ statusCode: 401 });
    expect(auth.verifyPassword).toHaveBeenCalledWith('Permanent123!', passwordHash);
    await expect(new AdminAuthService().login('atlas', 'Wrong123!')).rejects.toMatchObject({ statusCode: 401 });
    await expect(new AdminAuthService().login(' Atlas ', 'Permanent123!')).resolves.toMatchObject({ admin: { username: 'atlas' } });
  });

  it('accepts only unexpired sessions for an existing Admin', async () => {
    database.query.mockResolvedValueOnce({ rows: [{ username: 'atlas' }] });
    await expect(new AdminAuthService().session('token')).resolves.toEqual({ username: 'atlas' });
    const [sql, params] = database.query.mock.calls[0];
    expect(sql).toContain('expires_at > now()');
    expect(sql).toContain('CROSS JOIN admin');
    expect(params).toEqual([hashSessionToken('token')]);

    // An expired or revoked session matches no row.
    database.query.mockResolvedValueOnce({ rows: [] });
    await expect(new AdminAuthService().session('expired')).resolves.toBeNull();
    await expect(new AdminAuthService().session('')).resolves.toBeNull();
  });

  it('revokes the session on sign-out', async () => {
    database.query.mockResolvedValue({ rowCount: 1, rows: [] });
    await new AdminAuthService().logout('token');
    expect(database.query).toHaveBeenCalledWith('DELETE FROM admin_sessions WHERE token_hash = $1', [hashSessionToken('token')]);
  });

  it('changes the password only with the current password, revoking every session', async () => {
    const passwordHash = await hashPassword('Permanent123!');
    const query = useClient((sql) => (sql.startsWith('SELECT username')
      ? { rowCount: 1, rows: [{ username: 'atlas', password_hash: passwordHash }] }
      : undefined));

    await expect(new AdminAuthService().changePassword('Wrong123!', 'Replacement123!'))
      .rejects.toMatchObject({ statusCode: 403, code: 'INVALID_CURRENT_PASSWORD' });
    expect(statements(query)).not.toContain('DELETE FROM admin_sessions');

    query.mockClear();
    const session = await new AdminAuthService().changePassword('Permanent123!', 'Replacement123!');
    const sql = statements(query);
    expect(sql.indexOf('DELETE FROM admin_sessions')).toBeGreaterThan(sql.findIndex((statement) => statement.startsWith('UPDATE admin')));
    expect(sql.findIndex((statement) => statement.includes('INSERT INTO admin_sessions'))).toBeGreaterThan(sql.indexOf('DELETE FROM admin_sessions'));
    expect(sql.at(-1)).toBe('COMMIT');
    expect(session.admin).toEqual({ username: 'atlas' });
  });
});

describe('Admin cookie helpers', () => {
  it('compares secrets in constant time regardless of length', () => {
    expect(constantTimeEqual('secret', 'secret')).toBe(true);
    expect(constantTimeEqual('secret', 'secret-longer')).toBe(false);
  });

  it('builds an HttpOnly, SameSite=Strict cookie scoped to the admin API', () => {
    const cookie = sessionCookie('abc', new Date(Date.now() + 3_600_000), false);
    expect(cookie).toMatch(/^agt_admin_session=abc; Path=\/api\/admin; Max-Age=3\d{3}; HttpOnly; SameSite=Strict$/);
    expect(sessionCookie('abc', new Date(Date.now() + 3_600_000), true)).toMatch(/; Secure$/);
  });

  it('reads one cookie from a Cookie header', () => {
    expect(readCookie('theme=dark; agt_admin_session=token123', 'agt_admin_session')).toBe('token123');
    expect(readCookie('theme=dark', 'agt_admin_session')).toBeUndefined();
    expect(readCookie(undefined, 'agt_admin_session')).toBeUndefined();
  });
});
