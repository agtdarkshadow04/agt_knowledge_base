import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';
import pg from 'pg';
import { connectionParameters } from '../db.js';
import { closeTestServers, createTestServer, testDatabaseUrl, type TestServer } from './postgres.js';

/**
 * AGT sign-in end to end (issue #30): the app on a real PostgreSQL database
 * with a fake AGT IAM on a loopback port. Covers the first sign-in creating
 * the member, the role mapping on every sign-in, the Admin's limits on AGT
 * members, and `iam.enabled` switching off.
 */

const csrf = { 'x-agt-request': '1', 'content-type': 'application/json' };
const adminPassword = 'Admin-Password-1!';
const apiKey = 'fake-iam-api-key';
const agtPassword = 'q"uo,te+s\\ok';

interface Traveller {
  id: string;
  name: string;
  password: string;
  permission: string;
  isAuthorized?: boolean;
  expiresIn?: string;
  /** IAM's traveller.securityLevel; '2' unless a test sets it, `undefined` sends none. */
  securityLevel?: unknown;
}

let travellers: Traveller[] = [];
let calls: Array<{ identifier: string; password: string; appId: string; key: string | undefined }> = [];
/** When set, IAM holds its answer until the promise resolves. */
let hold: Promise<void> | null = null;

const iam = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', async () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { identifier: string; password: string; appId: string };
    calls.push({ ...body, key: request.headers['x-api-key'] as string | undefined });
    if (hold) await hold;
    const traveller = travellers.find((candidate) => candidate.name === body.identifier);
    response.setHeader('content-type', 'application/json');
    if (!traveller || traveller.password !== body.password) {
      response.writeHead(401).end(JSON.stringify({ error: traveller ? 'ERR_INVALID_CREDENTIALS' : 'ERR_IDENTITY_NOT_FOUND' }));
      return;
    }
    response.writeHead(200).end(JSON.stringify({
      authenticated: true,
      verified: true,
      token: 'iam-token',
      traveller: { travellerName: traveller.name, agtTravellerId: traveller.id, agtStatus: 'Active', securityLevel: 'securityLevel' in traveller ? traveller.securityLevel : '2' },
      applicationAuthorization: { requestedAppId: body.appId, permissionAssigned: traveller.permission, isAuthorized: traveller.isAuthorized ?? true, accessNotes: '' },
      metadata: { issuer: 'AGT-IAM', expiresIn: traveller.expiresIn ?? '24h', timestamp: new Date().toISOString() },
    }));
  });
});

let iamUrl = '';
const servers: TestServer[] = [];

before(async () => {
  await new Promise<void>((resolve) => iam.listen(0, '127.0.0.1', resolve));
  iamUrl = `http://127.0.0.1:${(iam.address() as AddressInfo).port}`;
});

after(async () => {
  try {
    await closeTestServers(servers);
  } finally {
    iam.closeAllConnections();
    await new Promise((resolve) => iam.close(resolve));
  }
});

beforeEach(() => {
  travellers = [
    { id: 'AGT-1001', name: 'Atlas Walker', password: agtPassword, permission: 'Moderator' },
    { id: 'AGT-1002', name: 'Nada', password: 'nada-pass', permission: 'NOACCESS' },
  ];
  calls = [];
  hold = null;
});

async function server(iamConfig: string, options: { iamApiKey?: string } = { iamApiKey: apiKey }) {
  const created = await createTestServer({
    config: `iam:\n  baseUrl: ${iamUrl}\n  appId: kb-app\n  timeoutSeconds: 5\n  roleMap:\n    Moderator: Moderator\n${iamConfig}`,
    ...options,
  });
  servers.push(created);
  return created;
}

function cookieFrom(reply: { headers: Record<string, unknown> }, name: string) {
  const cookies = ([] as string[]).concat((reply.headers['set-cookie'] as string | string[] | undefined) ?? []);
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  assert.ok(found, `no ${name} cookie`);
  return found;
}

function agtSignIn(target: TestServer, travellerName: string, password: string) {
  return target.app.inject({ method: 'POST', url: '/api/member/iam/login', headers: csrf, payload: { travellerName, password } });
}

async function signedIn(target: TestServer, travellerName = 'Atlas Walker', password = agtPassword) {
  const reply = await agtSignIn(target, travellerName, password);
  assert.equal(reply.statusCode, 200, reply.body);
  return cookieFrom(reply, 'agt_knowledge_base_member_session').split(';')[0];
}

async function setUpAdmin(target: TestServer) {
  const setup = await target.app.inject({
    method: 'POST', url: '/api/setup', headers: csrf,
    payload: { setupPassword: 'test-setup-password-1A!', username: 'keeper', password: adminPassword },
  });
  assert.equal(setup.statusCode, 201, setup.body);
  return cookieFrom(setup, 'agt_knowledge_base_session').split(';')[0];
}

async function query(target: TestServer, sql: string, values: unknown[] = []) {
  const url = connectionParameters({ connectionString: testDatabaseUrl(), ssl: false });
  const client = new pg.Client({ host: url.host, port: url.port, user: url.user, password: url.password, database: target.database });
  await client.connect();
  try {
    return (await client.query(sql, values)).rows;
  } finally {
    await client.end();
  }
}

function session(target: TestServer, cookie: string) {
  return target.app.inject({ method: 'GET', url: '/api/member/session', headers: { cookie } });
}

describe('AGT sign-in (issue #30)', () => {
  it('is off by default: no AGT sign-in, no call to AGT IAM', async () => {
    const target = await server('');
    const settings = await target.app.inject({ method: 'GET', url: '/api/settings/public' });
    assert.deepEqual(JSON.parse(settings.body).iam, { signIn: false });
    const reply = await agtSignIn(target, 'Atlas Walker', agtPassword);
    assert.equal(reply.statusCode, 403);
    assert.equal(JSON.parse(reply.body).error, 'iam_disabled');
    assert.equal(calls.length, 0);
  });

  it('answers 503 iam_unavailable while it is on but the API key is missing', async () => {
    const target = await server('  enabled: true\n', {});
    assert.deepEqual(JSON.parse((await target.app.inject({ method: 'GET', url: '/api/settings/public' })).body).iam, { signIn: false });
    const reply = await agtSignIn(target, 'Atlas Walker', agtPassword);
    assert.equal(reply.statusCode, 503);
    assert.equal(JSON.parse(reply.body).error, 'iam_unavailable');
    assert.equal(calls.length, 0);
  });

  it('creates the member at the first sign-in, maps the role at every sign-in, and never stores the password', async () => {
    const target = await server('  enabled: true\n');
    assert.deepEqual(JSON.parse((await target.app.inject({ method: 'GET', url: '/api/settings/public' })).body).iam, { signIn: true });

    const first = await agtSignIn(target, 'Atlas Walker', agtPassword);
    assert.equal(first.statusCode, 200, first.body);
    const member = JSON.parse(first.body);
    assert.deepEqual({ ...member, sub: undefined }, { sub: undefined, username: 'Atlas Walker', displayName: 'Atlas Walker', role: 'Moderator', securityLevel: 2, authSource: 'agt_iam' });
    assert.deepEqual(calls, [{ identifier: 'Atlas Walker', password: agtPassword, appId: 'kb-app', key: apiKey }]);
    // The session ends no later than session.ttlHours (12 h here) and IAM's own token.
    assert.match(cookieFrom(first, 'agt_knowledge_base_member_session'), /Max-Age=43[12]\d\d; HttpOnly; SameSite=Strict/);
    const cookie = cookieFrom(first, 'agt_knowledge_base_member_session').split(';')[0];
    assert.deepEqual(JSON.parse((await session(target, cookie)).body), member);

    const [row] = await query(target, 'SELECT * FROM local_users WHERE id = $1', [member.sub]);
    assert.equal(row.auth_source, 'agt_iam');
    assert.equal(row.username, null);
    assert.equal(row.password_hash, null);
    assert.equal(row.iam_traveller_id, 'AGT-1001');
    assert.equal(row.iam_permission, 'Moderator');
    assert.equal(row.security_level, 2);
    assert.ok(!JSON.stringify(await query(target, 'SELECT * FROM local_users')).includes(agtPassword));

    // An AGT member writes like any member, and the audit log names them without the password.
    const article = await target.app.inject({
      method: 'POST', url: '/api/articles', headers: { ...csrf, cookie },
      payload: { title: 'Portal notes', content: 'How to find and use the portals across the galaxy.', tagIds: [], visibility: 'Public' },
    });
    assert.equal(article.statusCode, 201, article.body);
    assert.equal(JSON.parse(article.body).createdByName, 'Atlas Walker');
    await target.logs.flush();
    const audit = await query(target, "SELECT actor_type, actor, action, details FROM logs.audit_log WHERE action = 'createMemberIamSession'");
    assert.deepEqual(audit.map((entry) => [entry.actor_type, entry.actor]), [['member', 'Atlas Walker']]);
    assert.ok(!JSON.stringify(await query(target, 'SELECT * FROM logs.audit_log')).includes(agtPassword));
    assert.ok(!JSON.stringify(await query(target, 'SELECT * FROM logs.server_log')).includes(agtPassword));
    assert.ok(!JSON.stringify(await query(target, 'SELECT * FROM logs.server_log')).includes(apiKey));

    // A new tier in IAM changes the role at the next sign-in and ends the older sessions (AUTH-4).
    travellers[0].permission = 'Contributor';
    travellers[0].expiresIn = '1h';
    const second = await agtSignIn(target, 'Atlas Walker', agtPassword);
    assert.equal(second.statusCode, 200, second.body);
    assert.equal(JSON.parse(second.body).sub, member.sub);
    assert.equal(JSON.parse(second.body).role, 'Editor');
    assert.match(cookieFrom(second, 'agt_knowledge_base_member_session'), /Max-Age=(3[0-5]\d\d|3600);/);
    assert.equal((await session(target, cookie)).statusCode, 401);
    assert.equal((await query(target, "SELECT count(*)::int AS count FROM local_users WHERE auth_source = 'agt_iam'"))[0].count, 1);
  });

  it('honours the security level IAM sends at every sign-in, and a change ends the other sessions (#70)', async () => {
    const target = await server('  enabled: true\n');
    travellers[0].securityLevel = '3';
    const cookie = await signedIn(target);
    assert.equal(JSON.parse((await session(target, cookie)).body).securityLevel, 3);
    // The stored value never wins over IAM's: even one changed in the database is replaced.
    await query(target, "UPDATE local_users SET security_level = 5 WHERE auth_source = 'agt_iam'");
    travellers[0].securityLevel = '1';
    const second = await agtSignIn(target, 'Atlas Walker', agtPassword);
    assert.equal(JSON.parse(second.body).securityLevel, 1);
    assert.deepEqual(await query(target, "SELECT security_level FROM local_users WHERE auth_source = 'agt_iam'"), [{ security_level: 1 }]);
    assert.equal((await session(target, cookie)).statusCode, 401);

    // The same level keeps the other sessions.
    const third = cookieFrom(second, 'agt_knowledge_base_member_session').split(';')[0];
    await signedIn(target);
    assert.equal((await session(target, third)).statusCode, 200);
  });

  it('refuses the sign-in, and creates nobody, when IAM sends no valid security level (#70)', async () => {
    const target = await server('  enabled: true\n');
    for (const securityLevel of [undefined, '', '9', 'Top Secret']) {
      travellers[0].securityLevel = securityLevel;
      const reply = await agtSignIn(target, 'Atlas Walker', agtPassword);
      assert.equal(reply.statusCode, 502, String(securityLevel));
      assert.equal(JSON.parse(reply.body).error, 'iam_bad_gateway');
    }
    assert.equal((await query(target, 'SELECT count(*)::int AS count FROM local_users'))[0].count, 0);
  });

  it('refuses wrong credentials and travellers IAM does not authorize for this app, and creates nobody', async () => {
    const target = await server('  enabled: true\n');
    const wrong = await agtSignIn(target, 'Atlas Walker', 'wrong');
    assert.equal(wrong.statusCode, 401);
    assert.equal(JSON.parse(wrong.body).error, 'invalid_credentials');
    const unknown = await agtSignIn(target, 'Nobody', 'whatever');
    assert.equal(JSON.parse(unknown.body).error, 'invalid_credentials');
    const denied = await agtSignIn(target, 'Nada', 'nada-pass');
    assert.equal(denied.statusCode, 403);
    assert.equal(JSON.parse(denied.body).error, 'app_access_denied');
    travellers.push({ id: 'AGT-1003', name: 'Unlisted', password: 'unlisted', permission: 'Moderator', isAuthorized: false });
    assert.equal(JSON.parse((await agtSignIn(target, 'Unlisted', 'unlisted')).body).error, 'app_access_denied');
    assert.equal((await query(target, 'SELECT count(*)::int AS count FROM local_users'))[0].count, 0);
  });

  it('checks the credentials before calling IAM: 1-42 characters, no control characters', async () => {
    const target = await server('  enabled: true\n');
    for (const [travellerName, password] of [['', 'x'], ['Atlas', ''], ['A'.repeat(43), 'x'], ['Atlas', 'line\nbreak'], ['Atlas\r', 'x'], ['   ', 'x']]) {
      const reply = await agtSignIn(target, travellerName, password);
      assert.equal(reply.statusCode, 400, `${JSON.stringify(travellerName)} ${JSON.stringify(password)}`);
      assert.equal(JSON.parse(reply.body).error, 'validation_failed');
    }
    // 42 code points are fine, even where each takes two UTF-16 units.
    travellers.push({ id: 'AGT-1004', name: '🚀'.repeat(42), password: '🔑'.repeat(42), permission: 'Editor' });
    const long = await agtSignIn(target, '🚀'.repeat(42), '🔑'.repeat(42));
    assert.equal(long.statusCode, 200);
    assert.equal(calls.length, 1);
    const missingCsrf = await target.app.inject({ method: 'POST', url: '/api/member/iam/login', headers: { 'content-type': 'application/json' }, payload: { travellerName: 'Atlas Walker', password: agtPassword } });
    assert.equal(missingCsrf.statusCode, 403);
    assert.equal(JSON.parse(missingCsrf.body).error, 'csrf');
  });

  it('never lets an AGT member sign in with a local password', async () => {
    const target = await server('  enabled: true\n');
    await signedIn(target);
    const local = await target.app.inject({ method: 'POST', url: '/api/member/login', headers: csrf, payload: { username: 'Atlas Walker', password: agtPassword } });
    assert.equal(local.statusCode, 401);
  });

  it('lets the Admin deactivate or delete an AGT member, but not change what AGT IAM owns', async () => {
    const target = await server('  enabled: true\n');
    const admin = await setUpAdmin(target);
    const cookie = await signedIn(target);
    const list = await target.app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: admin } });
    const [user] = JSON.parse(list.body).items;
    assert.deepEqual({ ...user, id: undefined, createdAt: undefined, updatedAt: undefined }, {
      id: undefined, createdAt: undefined, updatedAt: undefined,
      username: 'Atlas Walker', displayName: 'Atlas Walker', role: 'Moderator', securityLevel: 2, isActive: true,
      authSource: 'agt_iam', agtTravellerId: 'AGT-1001', iamPermission: 'Moderator',
    });
    const update = (changes: Record<string, unknown>) => target.app.inject({
      method: 'PUT', url: `/api/admin/users/${user.id}`, headers: { ...csrf, cookie: admin },
      payload: { username: user.username, displayName: user.displayName, role: user.role, isActive: true, ...changes },
    });
    for (const changes of [{ role: 'Editor' }, { displayName: 'Renamed' }, { username: 'atlas' }, { email: 'atlas@example.com' }, { securityLevel: 5 }, { securityLevel: 0 }]) {
      const reply = await update(changes);
      assert.equal(reply.statusCode, 409, JSON.stringify(changes));
      assert.equal(JSON.parse(reply.body).error, 'managed_by_iam');
    }
    const password = await target.app.inject({ method: 'PUT', url: `/api/admin/users/${user.id}/password`, headers: { ...csrf, cookie: admin }, payload: { password: 'New-Password-123!' } });
    assert.equal(password.statusCode, 409);
    assert.equal(JSON.parse(password.body).error, 'managed_by_iam');
    assert.equal((await session(target, cookie)).statusCode, 200);

    // Deactivation ends the sessions, and IAM's answer cannot bring the member back (AUTH-4).
    const deactivated = await update({ isActive: false });
    assert.equal(deactivated.statusCode, 200, deactivated.body);
    assert.equal(JSON.parse(deactivated.body).isActive, false);
    assert.equal((await session(target, cookie)).statusCode, 401);
    const refused = await agtSignIn(target, 'Atlas Walker', agtPassword);
    assert.equal(refused.statusCode, 401);
    assert.equal(JSON.parse(refused.body).error, 'invalid_credentials');

    // Deleting the account lets the traveller start again as a new member.
    assert.equal((await target.app.inject({ method: 'DELETE', url: `/api/admin/users/${user.id}`, headers: { 'x-agt-request': '1', cookie: admin } })).statusCode, 204);
    const again = await agtSignIn(target, 'Atlas Walker', agtPassword);
    assert.equal(again.statusCode, 200, again.body);
    assert.notEqual(JSON.parse(again.body).sub, user.id);
  });

  it('switching iam.enabled off in the dashboard ends every AGT session at once, and local members keep theirs', async () => {
    const target = await server('');
    const admin = await setUpAdmin(target);
    const settings = (values: Record<string, unknown>) => target.app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { ...csrf, cookie: admin }, payload: { values } });
    const on = await settings({ 'iam.enabled': true });
    assert.equal(on.statusCode, 200, on.body);
    assert.deepEqual(JSON.parse(on.body).iam, { enabled: true, available: true, missing: [] });

    const created = await target.app.inject({
      method: 'POST', url: '/api/admin/users', headers: { ...csrf, cookie: admin },
      payload: { username: 'scribe', displayName: 'Scribe', role: 'Editor', password: 'Member-Password-1!' },
    });
    assert.equal(created.statusCode, 201, created.body);
    const local = await target.app.inject({ method: 'POST', url: '/api/member/login', headers: csrf, payload: { username: 'scribe', password: 'Member-Password-1!' } });
    const localCookie = cookieFrom(local, 'agt_knowledge_base_member_session').split(';')[0];
    const agtCookie = await signedIn(target);

    const off = await settings({ 'iam.enabled': false });
    assert.equal(off.statusCode, 200, off.body);
    assert.equal((await query(target, "SELECT count(*)::int AS count FROM member_sessions session JOIN local_users member ON member.id = session.user_id WHERE member.auth_source = 'agt_iam'"))[0].count, 0);
    assert.equal((await session(target, agtCookie)).statusCode, 401);
    assert.equal((await session(target, localCookie)).statusCode, 200);
    assert.equal(JSON.parse((await agtSignIn(target, 'Atlas Walker', agtPassword)).body).error, 'iam_disabled');
    assert.equal((await query(target, "SELECT count(*)::int AS count FROM local_users WHERE auth_source = 'agt_iam'"))[0].count, 1);
  });

  it('a config file value locks iam.enabled against the dashboard (CFG-8)', async () => {
    const target = await server('  enabled: false\n');
    const admin = await setUpAdmin(target);
    const reply = await target.app.inject({ method: 'PUT', url: '/api/admin/settings', headers: { ...csrf, cookie: admin }, payload: { values: { 'iam.enabled': true } } });
    assert.equal(reply.statusCode, 409);
    assert.equal(JSON.parse(reply.body).error, 'defined_in_config');
  });

  it('asks AGT IAM outside the data write, so a slow IAM never holds up a backup (BAK-8)', async () => {
    const target = await server('  enabled: true\n');
    const admin = await setUpAdmin(target);
    let release!: () => void;
    hold = new Promise((resolve) => { release = resolve; });
    const pending = agtSignIn(target, 'Atlas Walker', agtPassword);
    while (calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
    // A backup takes the write lock exclusively; it would wait for a write in progress.
    const started = Date.now();
    const backup = await target.app.inject({ method: 'GET', url: '/api/admin/backup', headers: { cookie: admin } });
    assert.equal(backup.statusCode, 200);
    assert.ok(Date.now() - started < 10_000);
    release();
    assert.equal((await pending).statusCode, 200);
  });
});
