import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { AdminAuthService, constantTimeEqual, hashSessionToken, sessionCookie } from '../admin-auth.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from '../local-auth.js';
import { assertCalledWith, assertEquals, assertMatches, fakeDatabase, match, rejectsMatching, testContext } from './helpers.js';

type QueryFn = (sql: string, params?: unknown[]) => Promise<unknown>;

const database = {
  connect: mock.fn(async (): Promise<unknown> => undefined),
  query: mock.fn<QueryFn>(async () => undefined),
};
const auth = { verifyPassword: mock.fn(verifyPassword) };

const setupSecret = 'one-time-setup-secret';

function service(setupPassword: string | null = null) {
  return new AdminAuthService(
    testContext({ db: fakeDatabase(database), setupPassword }),
    { hashPassword, verifyPassword: auth.verifyPassword, dummyPasswordHash },
  );
}

function resetDatabase() {
  database.connect.mock.restore();
  database.connect.mock.resetCalls();
  database.query.mock.restore();
  database.query.mock.resetCalls();
}

function useClient(handler: (sql: string, params?: unknown[]) => unknown) {
  const query = mock.fn<QueryFn>(async (sql, params) => handler(sql, params) ?? { rowCount: 0, rows: [] });
  database.connect.mock.mockImplementation(async () => ({ query, release: mock.fn() }));
  return query;
}

function statements(query: { mock: { calls: { arguments: unknown[] }[] } }) {
  return query.mock.calls.map(({ arguments: [sql] }) => sql as string);
}

describe('Admin setup', () => {
  afterEach(resetDatabase);

  const input = { setupPassword: setupSecret, username: 'atlas', password: 'Permanent123!' };

  it('is refused when AGT_SETUP_PASSWORD is unset', async () => {
    await rejectsMatching(service(null).setup(input), { statusCode: 403, error: 'setup_disabled', legacyCode: 'SETUP_DISABLED' });
    assert.equal((database.query).mock.callCount(), 0);
  });

  it('requires the setup password', async () => {
    database.query.mock.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
    await rejectsMatching(service(setupSecret).setup({ ...input, setupPassword: 'guess' }), { statusCode: 401, error: 'invalid_setup_password', legacyCode: 'INVALID_SETUP_PASSWORD' });
    assert.equal((database.connect).mock.callCount(), 0);
  });

  it('rejects a new password equal to the setup password', async () => {
    database.query.mock.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
    await rejectsMatching(service(setupSecret).setup({ ...input, password: setupSecret }), { statusCode: 400, error: 'validation_failed', legacyCode: 'PASSWORD_REUSED' });
  });

  it('fails once an Admin exists, even with the setup password', async () => {
    database.query.mock.mockImplementation(async () => ({ rowCount: 1, rows: [{}] }));
    await rejectsMatching(service(setupSecret).setup(input), { statusCode: 409, error: 'setup_already_completed', legacyCode: 'SETUP_ALREADY_COMPLETED' });
    assert.equal((database.connect).mock.callCount(), 0);
  });

  it('handles a concurrent setup that inserted the Admin first', async () => {
    database.query.mock.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
    const query = useClient((sql) => (sql.includes('INSERT INTO admin ') ? { rowCount: 0, rows: [] } : undefined));
    await rejectsMatching(service(setupSecret).setup(input), { statusCode: 409 });
    assert.ok((statements(query)).includes('ROLLBACK'));
  });

  it('creates the Admin and a session, storing only the token hash', async () => {
    database.query.mock.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
    const query = useClient((sql) => (sql.includes('INSERT INTO admin ') ? { rowCount: 1, rows: [] } : undefined));

    const session = await service(setupSecret).setup(input);

    assert.deepEqual(session.admin, { username: 'atlas' });
    assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
    const adminInsert = query.mock.calls.find(({ arguments: [sql] }) => sql.includes('INSERT INTO admin '))!;
    assertEquals(adminInsert.arguments[1], ['atlas', match.stringMatching(/^scrypt\$/)]);
    const sessionInsert = query.mock.calls.find(({ arguments: [sql] }) => sql.includes('INSERT INTO admin_sessions'))!;
    assert.deepEqual(sessionInsert.arguments[1], [hashSessionToken(session.token), session.expiresAt]);
    assert.ok(!JSON.stringify(query.mock.calls.map((call) => call.arguments)).includes(session.token));
    assert.ok((statements(query)).includes('COMMIT'));
  });
});

describe('Admin sign-in and sessions', () => {
  afterEach(() => {
    resetDatabase();
    auth.verifyPassword.mock.resetCalls();
  });

  it('verifies against a dummy hash when no Admin exists', async () => {
    database.query.mock.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
    await rejectsMatching(service().login('atlas', 'Permanent123!'), { statusCode: 401, error: 'invalid_credentials', legacyCode: 'INVALID_CREDENTIALS' });
    assertCalledWith(auth.verifyPassword, 'Permanent123!', await dummyPasswordHash());
  });

  it('requires both the username and the password, checking the password either way', async () => {
    const passwordHash = await hashPassword('Permanent123!');
    database.query.mock.mockImplementation(async (sql: string) => (sql.startsWith('SELECT username')
      ? { rowCount: 1, rows: [{ username: 'atlas', password_hash: passwordHash }] }
      : { rowCount: 1, rows: [] }));

    await rejectsMatching(service().login('apollo', 'Permanent123!'), { statusCode: 401 });
    assertCalledWith(auth.verifyPassword, 'Permanent123!', passwordHash);
    await rejectsMatching(service().login('atlas', 'Wrong123!'), { statusCode: 401 });
    assertMatches(await service().login(' Atlas ', 'Permanent123!'), { admin: { username: 'atlas' } });
  });

  it('accepts only unexpired sessions for an existing Admin', async () => {
    database.query.mock.mockImplementationOnce(async () => ({ rows: [{ username: 'atlas' }] }));
    assert.deepEqual(await service().session('token'), { username: 'atlas' });
    const [sql, params] = database.query.mock.calls[0].arguments;
    assert.ok((sql).includes('expires_at > now()'));
    assert.ok((sql).includes('CROSS JOIN admin'));
    assert.deepEqual(params, [hashSessionToken('token')]);

    // An expired or revoked session matches no row.
    database.query.mock.mockImplementationOnce(async () => ({ rows: [] }));
    assert.equal(await service().session('expired'), null);
    assert.equal(await service().session(''), null);
  });

  it('revokes the session on sign-out', async () => {
    database.query.mock.mockImplementation(async () => ({ rowCount: 1, rows: [] }));
    await service().logout('token');
    assertCalledWith(database.query, 'DELETE FROM admin_sessions WHERE token_hash = $1', [hashSessionToken('token')]);
  });

  it('changes the password only with the current password, revoking every session', async () => {
    const passwordHash = await hashPassword('Permanent123!');
    const query = useClient((sql) => (sql.startsWith('SELECT username')
      ? { rowCount: 1, rows: [{ username: 'atlas', password_hash: passwordHash }] }
      : undefined));

    await rejectsMatching(service().changePassword('Wrong123!', 'Replacement123!'), { statusCode: 403, error: 'invalid_current_password', legacyCode: 'INVALID_CURRENT_PASSWORD' });
    assert.ok(!(statements(query)).includes('DELETE FROM admin_sessions'));

    query.mock.resetCalls();
    const session = await service().changePassword('Permanent123!', 'Replacement123!');
    const sql = statements(query);
    assert.ok((sql.indexOf('DELETE FROM admin_sessions')) > sql.findIndex((statement) => statement.startsWith('UPDATE admin')));
    assert.ok((sql.findIndex((statement) => statement.includes('INSERT INTO admin_sessions'))) > sql.indexOf('DELETE FROM admin_sessions'));
    assert.equal(sql.at(-1), 'COMMIT');
    assert.deepEqual(session.admin, { username: 'atlas' });
  });
});

describe('Admin cookie helpers', () => {
  it('compares secrets in constant time regardless of length', () => {
    assert.equal(constantTimeEqual('secret', 'secret'), true);
    assert.equal(constantTimeEqual('secret', 'secret-longer'), false);
  });

  it('builds an HttpOnly, SameSite=Strict cookie scoped to the admin API', () => {
    const cookie = sessionCookie('abc', new Date(Date.now() + 3_600_000), false);
    assert.match(cookie, /^agt_admin_session=abc; Path=\/api\/admin; Max-Age=3\d{3}; HttpOnly; SameSite=Strict$/);
    assert.match(sessionCookie('abc', new Date(Date.now() + 3_600_000), true), /; Secure$/);
  });

});
