import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { parseConfig } from '../config.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from '../passwords.js';
import { AdminAuthService, clearedCookie, hashSessionToken, MemberAuthService, sessionCookie } from '../session.js';
import { assertCalledWith, assertEquals, assertMatches, fakeDatabase, match, rejectsMatching, testContext } from './helpers.js';

type QueryFn = (sql: string, params?: unknown[]) => Promise<unknown>;

const database = {
  connect: mock.fn(async (): Promise<unknown> => undefined),
  query: mock.fn<QueryFn>(async () => undefined),
};
const auth = { verifyPassword: mock.fn(verifyPassword) };
const log = { error: mock.fn((_message: string) => undefined), info: mock.fn((_message: string) => undefined) };

const setupSecret = 'one-time-setup-secret';
const hasher = { hashPassword, verifyPassword: auth.verifyPassword, dummyPasswordHash };

function service(setupPassword: string | null = null) {
  return new AdminAuthService(testContext({ db: fakeDatabase(database), setupPassword }), hasher, log);
}

function members(config = '') {
  return new MemberAuthService({ config: parseConfig(config), db: fakeDatabase(database) }, hasher, log);
}

function reset() {
  database.connect.mock.restore();
  database.connect.mock.resetCalls();
  database.query.mock.restore();
  database.query.mock.resetCalls();
  auth.verifyPassword.mock.resetCalls();
  log.error.mock.resetCalls();
  log.info.mock.resetCalls();
}

function useClient(handler: (sql: string, params?: unknown[]) => unknown) {
  const query = mock.fn<QueryFn>(async (sql, params) => handler(sql, params) ?? { rowCount: 0, rows: [] });
  database.connect.mock.mockImplementation(async () => ({ query, release: mock.fn() }));
  return query;
}

function statements(query: { mock: { calls: { arguments: unknown[] }[] } }) {
  return query.mock.calls.map(({ arguments: [sql] }) => sql as string);
}

describe('Admin setup (AUTH-5, AUTH-6)', () => {
  afterEach(reset);

  const input = { setupPassword: setupSecret, username: 'Atlas Prime', password: 'Permanent123!' };

  it('reports adminExists and whether the setup password is configured', async () => {
    database.query.mock.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
    assert.deepEqual(await service(setupSecret).setupStatus(), { adminExists: false, setupPasswordConfigured: true, required: true });
    database.query.mock.mockImplementation(async () => ({ rowCount: 1, rows: [{}] }));
    assert.deepEqual(await service(null).setupStatus(), { adminExists: true, setupPasswordConfigured: false, required: false });
  });

  it('answers 503 setup_password_missing when AGT_KNOWLEDGE_BASE_SETUP_PASSWORD is unset', async () => {
    database.query.mock.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
    await rejectsMatching(service(null).setup(input), {
      statusCode: 503,
      error: 'setup_password_missing',
      legacyCode: 'SETUP_DISABLED',
      message: 'Setup is unavailable: AGT_KNOWLEDGE_BASE_SETUP_PASSWORD is not set. Set it in .env and restart.',
    });
    assert.equal(database.connect.mock.callCount(), 0);
  });

  it('requires the setup password', async () => {
    database.query.mock.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
    await rejectsMatching(service(setupSecret).setup({ ...input, setupPassword: 'guess' }), { statusCode: 401, error: 'invalid_setup_password', legacyCode: 'INVALID_SETUP_PASSWORD' });
    assert.equal(database.connect.mock.callCount(), 0);
  });

  it('rejects a new password equal to the setup password', async () => {
    database.query.mock.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
    await rejectsMatching(service(setupSecret).setup({ ...input, password: setupSecret }), {
      statusCode: 400, error: 'validation_failed', legacyCode: 'PASSWORD_REUSED', fields: [{ field: 'password', code: 'same_as_setup_password' }],
    });
  });

  it('answers 410 setup_complete once an Admin exists, even with or without the setup password', async () => {
    database.query.mock.mockImplementation(async () => ({ rowCount: 1, rows: [{}] }));
    await rejectsMatching(service(setupSecret).setup(input), { statusCode: 410, error: 'setup_complete', legacyCode: 'SETUP_ALREADY_COMPLETED' });
    await rejectsMatching(service(null).setup(input), { statusCode: 410, error: 'setup_complete' });
    assert.equal(database.connect.mock.callCount(), 0);
  });

  it('handles a concurrent setup that inserted the Admin first', async () => {
    database.query.mock.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
    const query = useClient((sql) => (sql.includes('INSERT INTO admin ') ? { rowCount: 0, rows: [] } : undefined));
    await rejectsMatching(service(setupSecret).setup(input), { statusCode: 410 });
    assert.ok(statements(query).includes('ROLLBACK'));
  });

  it('creates the Admin as entered, a session storing only the token hash, and logs the AUTH-6 reminder', async () => {
    database.query.mock.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
    const query = useClient((sql) => (sql.includes('INSERT INTO admin ') ? { rowCount: 1, rows: [] } : undefined));

    const session = await service(setupSecret).setup(input);

    assert.deepEqual(session.identity, { username: 'Atlas Prime' });
    assert.match(session.token, /^[A-Za-z0-9_-]{43}$/);
    const adminInsert = query.mock.calls.find(({ arguments: [sql] }) => sql.includes('INSERT INTO admin '))!;
    assertEquals(adminInsert.arguments[1], ['Atlas Prime', match.stringMatching(/^scrypt\$32768\$8\$1\$/)]);
    const sessionInsert = query.mock.calls.find(({ arguments: [sql] }) => sql.includes('INSERT INTO sessions'))!;
    assert.deepEqual(sessionInsert.arguments[1], [hashSessionToken(session.token), session.expiresAt]);
    assert.ok(statements(query).indexOf('DELETE FROM sessions WHERE expires_at <= now()') < statements(query).indexOf(sessionInsert.arguments[0] as string));
    assert.ok(!JSON.stringify(query.mock.calls.map((call) => call.arguments)).includes(session.token));
    assert.ok(statements(query).includes('COMMIT'));
    assertCalledWith(log.info, 'Admin account created. Remove AGT_KNOWLEDGE_BASE_SETUP_PASSWORD from .env and restart.');
  });
});

describe('Admin sign-in and sessions (AUTH-3, AUTH-4, AUTH-8)', () => {
  afterEach(reset);

  function adminRow(passwordHash: string, username = 'Atlas') {
    database.query.mock.mockImplementation(async (sql: string) => (sql.startsWith('SELECT username')
      ? { rowCount: 1, rows: [{ username, password_hash: passwordHash }] }
      : { rowCount: 1, rows: [] }));
  }

  it('verifies against a dummy hash when no Admin exists', async () => {
    database.query.mock.mockImplementation(async () => ({ rowCount: 0, rows: [] }));
    await rejectsMatching(service().login('atlas', 'Permanent123!'), { statusCode: 401, error: 'invalid_credentials', legacyCode: 'INVALID_CREDENTIALS' });
    assertCalledWith(auth.verifyPassword, 'Permanent123!', await dummyPasswordHash());
  });

  it('compares the trimmed username exactly and always checks the password', async () => {
    const passwordHash = await hashPassword('Permanent123!');
    adminRow(passwordHash);
    await rejectsMatching(service().login('apollo', 'Permanent123!'), { statusCode: 401, error: 'invalid_credentials' });
    assertCalledWith(auth.verifyPassword, 'Permanent123!', passwordHash);
    await rejectsMatching(service().login('atlas', 'Permanent123!'), { statusCode: 401 });
    await rejectsMatching(service().login('Atlas', 'Wrong123!'), { statusCode: 401 });
    assertMatches(await service().login(' Atlas ', 'Permanent123!'), { identity: { username: 'Atlas' } });
    assert.equal(database.query.mock.calls.some(({ arguments: [sql] }) => sql.startsWith('UPDATE admin')), false);
  });

  it('never verifies a malformed stored hash, answering like a wrong password and logging an error (AUTH-2)', async () => {
    adminRow('scrypt$1$8$1$AAAA$BBBB');
    await rejectsMatching(service().login('Atlas', 'Permanent123!'), { statusCode: 401, error: 'invalid_credentials' });
    assertCalledWith(log.error, 'The stored admin password hash is malformed or uses unsupported scrypt parameters.');
    assert.ok(!JSON.stringify(log.error.mock.calls).includes('scrypt$'));
  });

  it('rehashes a password stored with the 1.x profile on sign-in', async () => {
    auth.verifyPassword.mock.mockImplementationOnce(async () => ({ ok: true, rehash: true }));
    adminRow('scrypt$16384$8$1$legacy$legacy');
    await service().login('Atlas', 'Permanent123!');
    const update = database.query.mock.calls.find(({ arguments: [sql] }) => sql.startsWith('UPDATE admin'))!;
    assertEquals(update.arguments[1], [match.stringMatching(/^scrypt\$32768\$8\$1\$/)]);
  });

  it('accepts only unexpired sessions for an existing Admin', async () => {
    database.query.mock.mockImplementationOnce(async () => ({ rows: [{ username: 'atlas' }] }));
    assert.deepEqual(await service().session('token'), { username: 'atlas' });
    const [sql, params] = database.query.mock.calls[0].arguments;
    assert.ok(sql.includes('FROM sessions session'));
    assert.ok(sql.includes('expires_at > now()'));
    assert.ok(sql.includes('CROSS JOIN admin'));
    assert.deepEqual(params, [hashSessionToken('token')]);

    database.query.mock.mockImplementationOnce(async () => ({ rows: [] }));
    assert.equal(await service().session('expired'), null);
    assert.equal(await service().session(''), null);
    assert.equal(await service().session(undefined), null);
    assert.equal(await service().session('x'.repeat(201)), null);
  });

  it('revokes the session on sign-out', async () => {
    database.query.mock.mockImplementation(async () => ({ rowCount: 1, rows: [] }));
    await service().logout('token');
    assertCalledWith(database.query, 'DELETE FROM sessions WHERE token_hash = $1', [hashSessionToken('token')]);
  });

  it('changes the password only with the current password, ending every session (AUTH-4)', async () => {
    const passwordHash = await hashPassword('Permanent123!');
    const query = useClient((sql) => (sql.startsWith('SELECT username')
      ? { rowCount: 1, rows: [{ username: 'atlas', password_hash: passwordHash }] }
      : undefined));

    await rejectsMatching(service().changePassword('Wrong123!', 'Replacement123!'), { statusCode: 401, error: 'invalid_credentials', legacyCode: 'INVALID_CURRENT_PASSWORD' });
    assert.ok(!statements(query).includes('DELETE FROM sessions'));

    await rejectsMatching(service(setupSecret).changePassword('Permanent123!', setupSecret), { statusCode: 400, legacyCode: 'PASSWORD_REUSED' });

    query.mock.resetCalls();
    const session = await service().changePassword('Permanent123!', 'Replacement123!');
    const sql = statements(query);
    assert.ok(sql.indexOf('DELETE FROM sessions') > sql.findIndex((statement) => statement.startsWith('UPDATE admin')));
    assert.ok(sql.findIndex((statement) => statement.includes('INSERT INTO sessions')) > sql.indexOf('DELETE FROM sessions'));
    assert.equal(sql.at(-1), 'COMMIT');
    assert.deepEqual(session.identity, { username: 'atlas' });
  });
});

describe('member sign-in and sessions (AUTH-1 deviation)', () => {
  afterEach(reset);

  const memberRow = (passwordHash: string) => ({
    id: '10000000-0000-4000-8000-000000000001',
    username: 'traveller',
    password_hash: passwordHash,
    display_name: 'Traveller',
    email: 'traveller@example.com',
    role: 'Editor',
  });

  it('signs an active member in by normalized username and stores only the token hash', async () => {
    const passwordHash = await hashPassword('Permanent123!');
    database.query.mock.mockImplementation(async (sql: string) => (sql.startsWith('SELECT') ? { rows: [memberRow(passwordHash)] } : { rows: [] }));

    const session = await members('session:\n  ttlHours: 2\n').login(' Traveller ', 'Permanent123!');

    assert.deepEqual(session.identity, {
      sub: '10000000-0000-4000-8000-000000000001',
      username: 'traveller',
      displayName: 'Traveller',
      email: 'traveller@example.com',
      role: 'Editor',
    });
    assertCalledWith(database.query, match.stringContaining('is_active = true'), ['traveller']);
    assertCalledWith(database.query, 'DELETE FROM member_sessions WHERE expires_at <= now()');
    assertCalledWith(database.query, 'INSERT INTO member_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [
      hashSessionToken(session.token), '10000000-0000-4000-8000-000000000001', session.expiresAt,
    ]);
    assert.ok(Math.abs(session.expiresAt.getTime() - Date.now() - 2 * 3_600_000) < 5_000);
    assert.ok(!JSON.stringify(database.query.mock.calls).includes(session.token));
  });

  it('answers 401 invalid_credentials for an unknown member, a wrong password or a malformed hash', async () => {
    database.query.mock.mockImplementation(async () => ({ rows: [] }));
    await rejectsMatching(members().login('nobody', 'Permanent123!'), { statusCode: 401, error: 'invalid_credentials' });
    assertCalledWith(auth.verifyPassword, 'Permanent123!', await dummyPasswordHash());

    const passwordHash = await hashPassword('Permanent123!');
    database.query.mock.mockImplementation(async () => ({ rows: [memberRow(passwordHash)] }));
    await rejectsMatching(members().login('traveller', 'Wrong123!'), { statusCode: 401, error: 'invalid_credentials' });

    database.query.mock.mockImplementation(async () => ({ rows: [memberRow('scrypt$salt$hash')] }));
    await rejectsMatching(members().login('traveller', 'Permanent123!'), { statusCode: 401, error: 'invalid_credentials' });
    assert.equal(log.error.mock.callCount(), 1);
    assert.equal(database.query.mock.calls.some(({ arguments: [sql] }) => sql.includes('INSERT INTO member_sessions')), false);
  });

  it('rehashes a 1.x password on sign-in', async () => {
    auth.verifyPassword.mock.mockImplementationOnce(async () => ({ ok: true, rehash: true }));
    database.query.mock.mockImplementation(async (sql: string) => (sql.startsWith('SELECT') ? { rows: [memberRow('legacy')] } : { rows: [] }));
    await members().login('traveller', 'Permanent123!');
    const update = database.query.mock.calls.find(({ arguments: [sql] }) => sql.startsWith('UPDATE local_users'))!;
    assertEquals(update.arguments[1], ['10000000-0000-4000-8000-000000000001', match.stringMatching(/^scrypt\$32768\$/)]);
  });

  it('accepts only an unexpired session of an active member, and revokes it on sign-out', async () => {
    database.query.mock.mockImplementationOnce(async () => ({ rows: [{ id: 'u1', username: 'traveller', display_name: 'Traveller', email: null, role: 'Moderator' }] }));
    assert.deepEqual(await members().session('token'), { sub: 'u1', username: 'traveller', displayName: 'Traveller', email: undefined, role: 'Moderator' });
    const [sql, params] = database.query.mock.calls[0].arguments;
    assert.ok(sql.includes('FROM member_sessions session'));
    assert.ok(sql.includes('session.expires_at > now()'));
    assert.ok(sql.includes('member.is_active'));
    assert.deepEqual(params, [hashSessionToken('token')]);

    database.query.mock.mockImplementationOnce(async () => ({ rows: [] }));
    assert.equal(await members().session('expired'), null);
    assert.equal(await members().session(undefined), null);

    database.query.mock.mockImplementation(async () => ({ rows: [] }));
    await members().logout('token');
    assertCalledWith(database.query, 'DELETE FROM member_sessions WHERE token_hash = $1', [hashSessionToken('token')]);
  });
});

describe('session cookies (AUTH-8)', () => {
  it('builds HttpOnly, SameSite=Strict cookies with Path=/', () => {
    const cookie = sessionCookie('agt_knowledge_base_session', 'abc', new Date(Date.now() + 3_600_000), false);
    assert.match(cookie, /^agt_knowledge_base_session=abc; Path=\/; Max-Age=3\d{3}; HttpOnly; SameSite=Strict$/);
    assert.match(sessionCookie('agt_knowledge_base_session', 'abc', new Date(Date.now() + 3_600_000), true), /; Secure$/);
    assert.equal(clearedCookie('agt_admin_session', false, '/api/admin'), 'agt_admin_session=; Path=/api/admin; Max-Age=0; HttpOnly; SameSite=Strict');
  });
});
