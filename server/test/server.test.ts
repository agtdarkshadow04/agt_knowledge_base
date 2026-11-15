import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { Writable } from 'node:stream';
import { buildApp, contentSecurityPolicy, type App } from '../app.js';
import type { AdminIdentity, ApiRequest, ApiResponse } from '../routes.js';
import { apiRoutes, routeKeys } from '../routes.js';
import { HttpError } from '../http.js';
import type { AdminSessionResult, MemberUser, SessionResult } from '../session.js';
import { assertCalledWith, assertMatches, callArgs, fakeDatabase, match, testContext } from './helpers.js';

/** The HTTP pipeline: session separation, CSRF, cookies, body limits and rate limits, over a real socket. */

const mocks = {
  session: mock.fn(async (_token: string | undefined): Promise<AdminIdentity | null> => null),
  login: mock.fn(async (_username: string, _password: string): Promise<AdminSessionResult> => { throw new Error('unused'); }),
  logout: mock.fn(async (_token: string | undefined) => undefined),
  setup: mock.fn(async (_input: unknown): Promise<AdminSessionResult> => { throw new Error('unused'); }),
  setupStatus: mock.fn(async () => ({ adminExists: true, setupPasswordConfigured: false, required: false })),
  changePassword: mock.fn(async (_current: string, _password: string): Promise<AdminSessionResult> => { throw new Error('unused'); }),
  memberSession: mock.fn(async (_token: string | undefined): Promise<MemberUser | null> => null),
  memberLogin: mock.fn(async (_identifier: string, _password: string): Promise<SessionResult<MemberUser>> => {
    throw new HttpError(401, 'invalid_credentials', 'Invalid username or password.');
  }),
  memberLogout: mock.fn(async (_token: string | undefined) => undefined),
  handleRequest: mock.fn(async (_request: ApiRequest): Promise<ApiResponse> => ({ statusCode: 200, headers: {}, body: '{"ok":"member"}' })),
  handleAdminRequest: mock.fn(async (_request: ApiRequest): Promise<ApiResponse> => ({ statusCode: 200, headers: {}, body: '{"ok":"admin"}' })),
  values: mock.fn(async () => ({ 'backup.maxZipBytes': 1000 })),
};

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }

let app: App;
let port: number;
let now = 0;

let logLines: string[] = [];

async function start(config = '', setupPassword: string | null = null) {
  await app?.close();
  logLines = [];
  const stream = new Writable({ write(chunk, _encoding, done) { logLines.push(String(chunk)); done(); } });
  app = buildApp(testContext({ config, setupPassword }), {
    logger: { level: 'warn', stream },
    rateLimitClock: () => now,
    handlers: { request: mocks.handleRequest, admin: mocks.handleAdminRequest },
    services: {
      memberAuth: { login: mocks.memberLogin, session: mocks.memberSession, logout: mocks.memberLogout },
      adminAuth: {
        session: mocks.session,
        login: mocks.login,
        logout: mocks.logout,
        setup: mocks.setup,
        setupStatus: mocks.setupStatus,
        changePassword: mocks.changePassword,
      },
      settings: { values: mocks.values as never },
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
}

function send(method: string, path: string, options: { headers?: Record<string, string>; body?: string | Buffer } = {}) {
  // Node's client frames bodies of every method only when told the length (or chunking).
  // String bodies are JSON unless the test says otherwise.
  const headers = options.body === undefined || options.headers?.['transfer-encoding']
    ? options.headers
    : {
      'content-length': String(Buffer.byteLength(options.body)),
      ...(typeof options.body === 'string' ? { 'content-type': 'application/json' } : {}),
      ...options.headers,
    };
  return new Promise<Reply>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(options.body);
  });
}

const csrf = { 'x-agt-request': '1' };
const memberCookie = { cookie: 'agt_knowledge_base_member_session=member-token' };
/** A member write: the member cookie and the CSRF header (SEC-5). */
const moderatorToken = { ...memberCookie, ...csrf };
const article = { title: 'Portal Guide', content: 'Enough Markdown content for the article.', tagIds: [] };
const adminCookie = { cookie: 'agt_knowledge_base_session=admin-token' };
const moderator: MemberUser = { sub: 'moderator-sub', username: 'mod', displayName: 'Moderator', role: 'Moderator' };

beforeEach(async () => {
  now += 24 * 60 * 60 * 1000;
  for (const fn of Object.values(mocks)) {
    fn.mock.restore();
    fn.mock.resetCalls();
  }
  mocks.memberSession.mock.mockImplementation(async (token) => (token === 'member-token' ? moderator : null));
  mocks.session.mock.mockImplementation(async (token) => (token === 'admin-token' ? { username: 'atlas' } : null));
  await start();
});

afterEach(async () => {
  await app.close();
});

function concrete(routeKey: string) {
  const [method, path] = routeKey.split(' ');
  return [method, path.replace(/\{[^}]+\}/g, '00000000-0000-4000-8000-000000000001')] as const;
}

describe('session separation', () => {
  it('refuses every admin-session route with a member session cookie, including a Moderator\'s', async () => {
    const adminRoutes = routeKeys.filter((key) => key.includes(' /api/admin/')
      && !['GET /api/admin/setup/status', 'POST /api/admin/setup', 'POST /api/admin/auth/login', 'POST /api/admin/login'].includes(key));
    for (const key of adminRoutes) {
      const [method, path] = concrete(key);
      const reply = await send(method, path, { headers: { ...moderatorToken, ...csrf }, body: method === 'GET' ? undefined : '{}' });
      assert.equal(reply.status, 401, key);
    }
    assert.equal(mocks.memberSession.mock.callCount(), 0);
    assert.equal(mocks.handleAdminRequest.mock.callCount(), 0);
  });

  it('refuses member routes with only an Admin cookie', async () => {
    for (const { routeKey } of apiRoutes.filter((route) => route.auth === 'member')) {
      const [method, path] = concrete(routeKey);
      const reply = await send(method, path, { headers: { ...adminCookie, ...csrf }, body: method === 'GET' ? undefined : '{}' });
      assert.equal(reply.status, 401, routeKey);
    }
    // Public reads are dispatched without any identity.
    for (const path of ['/api/settings/public', '/api/settings', '/api/articles', '/api/articles/00000000-0000-4000-8000-000000000001', '/api/tags']) {
      assert.equal((await send('GET', path, { headers: adminCookie })).status, 200, path);
    }
    assert.equal(mocks.session.mock.callCount(), 0);
    for (const call of mocks.handleRequest.mock.calls) assert.equal(call.arguments[0].actor, null);
  });

  it('passes the Admin, and never a member actor, to admin handlers', async () => {
    const reply = await send('GET', '/api/admin/stats', { headers: { cookie: 'agt_knowledge_base_session=admin-token; agt_knowledge_base_member_session=member-token' } });
    assert.equal(reply.status, 200);
    assertMatches(callArgs(mocks.handleAdminRequest)[0], { admin: { username: 'atlas' }, actor: null });
    assert.equal(mocks.memberSession.mock.callCount(), 0);
  });

  it('passes the signed-in member as the actor to member handlers', async () => {
    const reply = await send('POST', '/api/articles', { headers: moderatorToken, body: JSON.stringify(article) });
    assert.equal(reply.status, 200);
    assertCalledWith(mocks.memberSession, 'member-token');
    assertMatches(callArgs(mocks.handleRequest)[0], {
      routeKey: 'POST /api/articles',
      actor: { sub: 'moderator-sub', role: 'Moderator', displayName: 'Moderator' },
      body: article,
    });
  });

  it('ignores bearer tokens: member routes need the session cookie (FE-3)', async () => {
    const reply = await send('GET', '/api/member/session', { headers: { authorization: 'Bearer member-token' } });
    assert.equal(reply.status, 401);
    assert.deepEqual(JSON.parse(reply.body), { error: 'unauthorized', code: 'UNAUTHENTICATED', message: 'Sign-in is required.' });
    assert.equal(mocks.memberSession.mock.callCount(), 1);
    assert.equal(callArgs(mocks.memberSession)[0], undefined);
  });

  it('clears an unknown or expired session cookie', async () => {
    const admin = await send('GET', '/api/admin/session', { headers: { cookie: 'agt_knowledge_base_session=expired' } });
    assert.equal(admin.status, 401);
    assert.match(admin.headers['set-cookie']?.[0] ?? '', /^agt_knowledge_base_session=; Path=\/; Max-Age=0/);
    const member = await send('GET', '/api/member/session', { headers: { cookie: 'agt_knowledge_base_member_session=expired' } });
    assert.equal(member.status, 401);
    assert.match(member.headers['set-cookie']?.[0] ?? '', /^agt_knowledge_base_member_session=; Path=\/; Max-Age=0/);
  });
});

describe('CSRF protection', () => {
  it('requires x-agt-request on every state-changing admin, setup and member request, before authentication (SEC-5)', async () => {
    const writes = apiRoutes.filter((route) => route.method !== 'GET' && route.auth !== 'none');
    for (const [method, path] of [['POST', '/api/admin/auth/login'], ['POST', '/api/admin/login'], ['POST', '/api/setup'], ['POST', '/api/admin/setup'], ['POST', '/api/member/login'], ...writes.map((route) => concrete(route.routeKey))]) {
      const reply = await send(method, path, { headers: { cookie: `${adminCookie.cookie}; ${memberCookie.cookie}` }, body: '{}' });
      assert.equal(reply.status, 403, `${method} ${path}`);
      assertMatches(JSON.parse(reply.body), { error: 'csrf', code: 'CSRF_HEADER_REQUIRED' });
    }
    assert.equal(mocks.session.mock.callCount(), 0);
    assert.equal(mocks.memberSession.mock.callCount(), 0);
    assert.equal((await send('PUT', '/api/admin/settings', { headers: { ...adminCookie, ...csrf }, body: '{"values":{}}' })).status, 200);
    assert.equal((await send('POST', '/api/articles', { headers: moderatorToken, body: JSON.stringify(article) })).status, 200);
  });

  it('does not require the header on reads', async () => {
    assert.equal((await send('GET', '/api/admin/stats', { headers: adminCookie })).status, 200);
    assert.equal((await send('GET', '/api/member/articles', { headers: memberCookie })).status, 200);
  });

  it('sends no CORS headers and answers no preflight, even with the deprecated server.frontendOrigin (SEC-6)', async () => {
    for (const config of ['', 'server:\n  frontendOrigin: https://kb.example.org\n']) {
      await start(config);
      const preflight = await send('OPTIONS', '/api/admin/settings', { headers: { origin: 'https://kb.example.org', 'access-control-request-method': 'PUT' } });
      assert.equal(preflight.status, 404, config);
      const read = await send('GET', '/api/settings/public', { headers: { origin: 'https://kb.example.org' } });
      assert.deepEqual(Object.keys(read.headers).filter((name) => name.startsWith('access-control-')), [], config);
    }
  });
});

describe('Admin session cookies', () => {
  it('sets agt_knowledge_base_session (HttpOnly, SameSite=Strict, Path=/) on sign-in, clears the 1.x cookie, and clears both on sign-out (AUTH-8)', async () => {
    mocks.login.mock.mockImplementation(async () => ({ token: 'new-token', expiresAt: new Date(Date.now() + 3_600_000), identity: { username: 'atlas' } }));
    const login = await send('POST', '/api/admin/login', { headers: csrf, body: JSON.stringify({ username: 'atlas', password: 'Permanent123!' }) });
    assert.equal(login.status, 200);
    assert.deepEqual(JSON.parse(login.body), { username: 'atlas', setupPasswordStillSet: false, setupPasswordSet: false, version: '1.0.0' });
    assert.match(login.headers['set-cookie']?.[0] ?? '', /^agt_knowledge_base_session=new-token; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict$/);
    assert.equal(login.headers['set-cookie']?.[1], 'agt_admin_session=; Path=/api/admin; Max-Age=0; HttpOnly; SameSite=Strict');
    assert.ok(!login.body.includes('new-token'));

    const logout = await send('POST', '/api/admin/logout', { headers: { ...adminCookie, ...csrf } });
    assert.equal(logout.status, 204);
    assertCalledWith(mocks.logout, 'admin-token');
    assert.match(logout.headers['set-cookie']?.[0] ?? '', /^agt_knowledge_base_session=; Path=\/; Max-Age=0/);
    assert.match(logout.headers['set-cookie']?.[1] ?? '', /^agt_admin_session=; Path=\/api\/admin; Max-Age=0/);
  });

  it('never accepts the 1.x Admin cookie', async () => {
    const reply = await send('GET', '/api/admin/session', { headers: { cookie: 'agt_admin_session=admin-token' } });
    assert.equal(reply.status, 401);
  });

  it('marks the cookie Secure when the deprecated server.frontendOrigin is HTTPS', async () => {
    await start('server:\n  frontendOrigin: https://kb.example.org\n');
    mocks.login.mock.mockImplementation(async () => ({ token: 't', expiresAt: new Date(Date.now() + 3_600_000), identity: { username: 'atlas' } }));
    const login = await send('POST', '/api/admin/auth/login', { headers: csrf, body: JSON.stringify({ username: 'atlas', password: 'x' }) });
    assert.match(login.headers['set-cookie']?.[0] ?? '', /; Secure$/);
  });

  it('follows session.secureCookie, and the deprecated adminSession.secureCookie', async () => {
    mocks.login.mock.mockImplementation(async () => ({ token: 't', expiresAt: new Date(Date.now() + 3_600_000), identity: { username: 'atlas' } }));
    const body = JSON.stringify({ username: 'atlas', password: 'x' });
    for (const config of ['session:\n  secureCookie: true\n', 'adminSession:\n  secureCookie: true\n']) {
      await start(config);
      assert.match((await send('POST', '/api/admin/login', { headers: csrf, body })).headers['set-cookie']?.[0] ?? '', /; Secure$/, config);
    }
    await start('session:\n  secureCookie: false\nserver:\n  frontendOrigin: https://kb.example.org\n');
    assert.doesNotMatch((await send('POST', '/api/admin/login', { headers: csrf, body })).headers['set-cookie']?.[0] ?? '', /Secure/);
  });

  it('trusts X-Forwarded-Proto only from a trusted proxy', async () => {
    mocks.login.mock.mockImplementation(async () => ({ token: 't', expiresAt: new Date(Date.now() + 3_600_000), identity: { username: 'atlas' } }));
    const headers = { ...csrf, 'x-forwarded-proto': 'https' };
    const body = JSON.stringify({ username: 'atlas', password: 'x' });
    assert.doesNotMatch((await send('POST', '/api/admin/auth/login', { headers, body })).headers['set-cookie']?.[0] ?? '', /Secure/);
    await start('server:\n  trustProxy: 1\n');
    assert.match((await send('POST', '/api/admin/auth/login', { headers, body })).headers['set-cookie']?.[0] ?? '', /; Secure$/);
  });

  it('reports a still-configured setup password so the dashboard can remind the Admin (AUTH-6)', async () => {
    await start('', 'still-here');
    const reply = await send('GET', '/api/admin/session', { headers: adminCookie });
    assert.deepEqual(JSON.parse(reply.body), { username: 'atlas', setupPasswordStillSet: true, setupPasswordSet: true, version: '1.0.0' });
  });
});

describe('member sessions (AUTH-1 deviation)', () => {
  it('signs in with the CSRF header, sets the member cookie and returns the profile without a token', async () => {
    mocks.memberLogin.mock.mockImplementation(async () => ({ token: 'secret-token', expiresAt: new Date(Date.now() + 3_600_000), identity: moderator }));
    const reply = await send('POST', '/api/member/login', { headers: csrf, body: JSON.stringify({ username: 'mod', password: 'Permanent123!' }) });
    assert.equal(reply.status, 200);
    assert.deepEqual(JSON.parse(reply.body), moderator);
    assert.match(reply.headers['set-cookie']?.[0] ?? '', /^agt_knowledge_base_member_session=secret-token; Path=\/; Max-Age=\d+; HttpOnly; SameSite=Strict$/);
    assert.ok(!reply.body.includes('secret-token'));
    assertCalledWith(mocks.memberLogin, 'mod', 'Permanent123!');
  });

  it('returns the member from the session route and signs out', async () => {
    assert.deepEqual(JSON.parse((await send('GET', '/api/member/session', { headers: memberCookie })).body), moderator);
    const logout = await send('POST', '/api/member/logout', { headers: moderatorToken });
    assert.equal(logout.status, 204);
    assertCalledWith(mocks.memberLogout, 'member-token');
    assert.match(logout.headers['set-cookie']?.[0] ?? '', /^agt_knowledge_base_member_session=; Path=\/; Max-Age=0/);
  });

  it('no longer serves the 1.x bearer-token routes', async () => {
    assert.equal((await send('POST', '/api/auth/login', { body: '{"username":"a","password":"b"}' })).status, 404);
    assert.equal((await send('GET', '/api/auth/session', { headers: { authorization: 'Bearer x' } })).status, 404);
  });
});

describe('request body limits', () => {
  it('rejects an anonymous upload before reading its body', async () => {
    const reply = await new Promise<Reply>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/api/admin/backup/restore?action=preview',
        headers: { ...csrf, 'content-type': 'application/zip', 'content-length': String(200 * 1024 * 1024) },
      }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => { request.destroy(); resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks).toString() }); });
      });
      request.on('error', (error) => { if (!('code' in error && error.code === 'ECONNRESET')) reject(error); });
      // Send only the first bytes of a declared 200 MB body: the reply arrives without the rest.
      request.write(Buffer.alloc(1024));
    });
    assert.equal(reply.status, 401);
    assert.equal(mocks.values.mock.callCount(), 0);
    assert.equal(mocks.handleAdminRequest.mock.callCount(), 0);
  });

  it('rejects an authenticated upload over backup.maxZipBytes with 413', async () => {
    const reply = await send('POST', '/api/admin/backup/restore?action=preview', {
      headers: { ...adminCookie, ...csrf, 'content-type': 'application/zip' },
      body: Buffer.alloc(1001),
    });
    assert.equal(reply.status, 413);
    assertMatches(JSON.parse(reply.body), { error: 'file_too_large', code: 'BODY_TOO_LARGE', params: { maxBytes: 1000 } });
    assert.equal(mocks.handleAdminRequest.mock.callCount(), 0);
  });

  it('rejects an upload over backup.maxBytes that does not declare its length', async () => {
    const reply = await send('POST', '/api/admin/backup/restore?action=preview', {
      headers: { ...adminCookie, ...csrf, 'content-type': 'application/zip', 'transfer-encoding': 'chunked' },
      body: Buffer.alloc(1001),
    });
    assert.equal(reply.status, 413);
    assert.equal(mocks.handleAdminRequest.mock.callCount(), 0);
  });

  it('passes an upload within backup.maxBytes to the handler as raw bytes', async () => {
    const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]);
    await send('POST', '/api/admin/backup/restore?action=preview', { headers: { ...adminCookie, ...csrf }, body: archive });
    const [request] = callArgs(mocks.handleAdminRequest) as [ApiRequest];
    assert.equal(Buffer.compare(request.rawBody!, archive), 0);
    assert.equal(request.body, undefined);
    assert.deepEqual({ ...request.query }, { action: 'preview' });
  });

  it('keeps the default 1 MB limit on other routes', async () => {
    const reply = await send('POST', '/api/articles', { headers: moderatorToken, body: 'x'.repeat(1_000_001) });
    assert.equal(reply.status, 413);
    assertMatches(JSON.parse(reply.body), { error: 'body_too_large', code: 'BODY_TOO_LARGE', message: 'Request body is too large.' });
  });
});

describe('error bodies', () => {
  it('answers unknown routes with the JSON error body', async () => {
    const reply = await send('GET', '/api/nope');
    assert.equal(reply.status, 404);
    assert.deepEqual(JSON.parse(reply.body), { error: 'not_found', code: 'NOT_FOUND', message: 'Route not found.' });
    assert.match(String(reply.headers['content-type']), /^application\/json/);
  });

  it('rejects malformed JSON on sign-in', async () => {
    const reply = await send('POST', '/api/member/login', { headers: csrf, body: '{' });
    assert.equal(reply.status, 400);
    assertMatches(JSON.parse(reply.body), { error: 'invalid_request', code: 'INVALID_REQUEST' });
  });

  it('answers a body that misses required fields with field errors (API-6)', async () => {
    const reply = await send('POST', '/api/member/login', { headers: csrf, body: '{}' });
    assert.equal(reply.status, 400);
    assertMatches(JSON.parse(reply.body), {
      error: 'validation_failed',
      code: 'VALIDATION_ERROR',
      fields: [{ field: 'username', code: 'required', message: 'username is required.' }],
    });
  });

  it('rejects undeclared body properties instead of dropping them (API-10)', async () => {
    const reply = await send('POST', '/api/articles', { headers: moderatorToken, body: JSON.stringify({ ...article, createdBy: 'someone-else' }) });
    assert.equal(reply.status, 400);
    assertMatches(JSON.parse(reply.body), { error: 'validation_failed', fields: [{ field: 'createdBy', code: 'not_allowed' }] });
    assert.equal(mocks.handleRequest.mock.callCount(), 0);
  });

  it('turns semantic validation failures into field errors with the 1.x issues kept', async () => {
    mocks.handleRequest.mock.mockImplementation(async () => {
      const { parseArticleWrite } = await import('../../src/lib/validation.js');
      parseArticleWrite({ ...article, title: 'x' });
      return { statusCode: 200, headers: {}, body: {} };
    });
    const reply = await send('POST', '/api/articles', { headers: moderatorToken, body: JSON.stringify(article) });
    assert.equal(reply.status, 400);
    const body = JSON.parse(reply.body);
    assertMatches(body, { error: 'validation_failed', code: 'VALIDATION_ERROR', fields: [{ field: 'title', code: 'too_short', params: { min: 3 } }] });
    assert.ok(Array.isArray(body.issues));
  });

  it('hides unexpected errors behind a generic 500', async () => {
    mocks.handleRequest.mock.mockImplementation(async () => { throw new Error('database password is wrong'); });
    const reply = await send('GET', '/api/settings');
    assert.equal(reply.status, 500);
    assert.deepEqual(JSON.parse(reply.body), { error: 'internal', code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.' });
  });
});

describe('rate limits (SEC-7)', () => {
  const login = (headers: Record<string, string> = {}) => send('POST', '/api/member/login', { headers: { ...csrf, ...headers }, body: JSON.stringify({ username: 'apollo', password: 'wrong' }) });

  it('limits member sign-in per client and reports Retry-After', async () => {
    // rateLimits.login defaults to 10 per 15 minutes.
    for (let attempt = 0; attempt < 10; attempt += 1) assert.equal((await login()).status, 401);
    const limited = await login();
    assert.equal(limited.status, 429);
    assertMatches(JSON.parse(limited.body), { error: 'rate_limited', code: 'RATE_LIMITED', params: { retryAfterSeconds: match.any(Number) } });
    assert.ok(Number(limited.headers['retry-after']) > 14 * 60);
    assert.equal(mocks.memberLogin.mock.callCount(), 10);
    // The window ends.
    now += 15 * 60 * 1000;
    assert.equal((await login()).status, 401);
  });

  it('counts clients behind a trusted proxy by their forwarded address', async () => {
    await start('server:\n  trustProxy: 1\nrateLimits:\n  login:\n    max: 1\n');
    const from = (address: string) => ({ 'x-forwarded-for': address });
    assert.equal((await login(from('203.0.113.9'))).status, 401);
    assert.equal((await login(from('203.0.113.9'))).status, 429);
    // Another client, and a forged left-most entry, are counted by the address the proxy saw.
    assert.equal((await login(from('198.51.100.1'))).status, 401);
    assert.equal((await login(from('203.0.113.9, 198.51.100.7'))).status, 401);
  });

  it('ignores X-Forwarded-For unless the proxy is trusted', async () => {
    await start('rateLimits:\n  login:\n    max: 1\n');
    assert.equal((await login({ 'x-forwarded-for': '203.0.113.1' })).status, 401);
    assert.equal((await login({ 'x-forwarded-for': '203.0.113.2' })).status, 429);
  });

  it('applies rateLimits.login to Admin sign-in with its own counter, before checking credentials', async () => {
    await start('rateLimits:\n  login:\n    max: 1\n');
    mocks.login.mock.mockImplementation(async () => { throw new Error('x'); });
    const credentials = '{"username":"a","password":"b"}';
    assert.equal((await login()).status, 401);
    await send('POST', '/api/admin/login', { headers: csrf, body: credentials });
    assert.equal((await send('POST', '/api/admin/login', { headers: csrf, body: credentials })).status, 429);
    // The deprecated path shares the bucket of its replacement.
    assert.equal((await send('POST', '/api/admin/auth/login', { headers: csrf, body: credentials })).status, 429);
    assert.equal(mocks.login.mock.callCount(), 1);
  });

  it('limits backup uploads with rateLimits.adminUploads', async () => {
    await start('rateLimits:\n  adminUploads:\n    max: 1\n');
    const upload = () => send('POST', '/api/admin/backup/restore?action=preview', { headers: { ...adminCookie, ...csrf, 'content-type': 'application/zip' }, body: Buffer.from('zip') });
    assert.equal((await upload()).status, 200);
    assert.equal((await upload()).status, 429);
  });

  it('still applies the deprecated rateLimits.adminLogin before checking credentials', async () => {
    await start('rateLimits:\n  adminLogin:\n    max: 1\n');
    mocks.login.mock.mockImplementation(async () => { throw new Error('x'); });
    await send('POST', '/api/admin/auth/login', { headers: csrf, body: '{"username":"a","password":"b"}' });
    const limited = await send('POST', '/api/admin/auth/login', { headers: csrf, body: '{"username":"a","password":"b"}' });
    assert.equal(limited.status, 429);
    assert.equal(mocks.login.mock.callCount(), 1);
  });
});

describe('security headers (SEC-1..SEC-3)', () => {
  const expected = {
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https: http: blob:; font-src 'self'; connect-src 'self'; media-src 'self'; worker-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'strict-origin-when-cross-origin',
    'cross-origin-opener-policy': 'same-origin',
    'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
    pragma: 'no-cache',
    expires: '0',
  };

  it('sends the exact CSP and the SEC-2/SEC-3 headers on successes, errors and unknown routes', async () => {
    assert.equal(contentSecurityPolicy, expected['content-security-policy']);
    for (const [method, path, headers] of [
      ['GET', '/api/settings/public', {}],
      ['GET', '/api/admin/stats', {}],
      ['GET', '/api/admin/stats', adminCookie],
      ['POST', '/api/articles', memberCookie],
      ['GET', '/nope', {}],
    ] as const) {
      const reply = await send(method, path, { headers, body: method === 'POST' ? '{}' : undefined });
      for (const [name, value] of Object.entries(expected)) assert.equal(reply.headers[name], value, `${method} ${path} ${name}`);
    }
  });
});

describe('plain-HTTP warning (SEC-4)', () => {
  it('warns once per process when credentials arrive over plain HTTP from another host', async () => {
    await start('server:\n  trustProxy: 1\n');
    mocks.login.mock.mockImplementation(async () => { throw new HttpError(401, 'invalid_credentials', 'Invalid username or password.'); });
    await login('127.0.0.1');
    assert.equal(logLines.filter((line) => line.includes('plain HTTP')).length, 0);
    await login('203.0.113.9');
    await login('203.0.113.10');
    await send('POST', '/api/admin/login', { headers: { ...csrf, 'x-forwarded-for': '203.0.113.11' }, body: '{"username":"a","password":"b"}' });
    const warnings = logLines.filter((line) => line.includes('plain HTTP')).map((line) => JSON.parse(line));
    assert.equal(warnings.length, 1);
    assertMatches(warnings[0], { level: 40, source: 'security', msg: match.stringContaining('203.0.113.9') });
    // HTTPS reported by the trusted proxy is not plain HTTP.
    await start('server:\n  trustProxy: 1\n');
    await login('203.0.113.9', 'https');
    assert.equal(logLines.filter((line) => line.includes('plain HTTP')).length, 0);
  });

  function login(address: string, proto = 'http') {
    return send('POST', '/api/member/login', { headers: { ...csrf, 'x-forwarded-for': address, 'x-forwarded-proto': proto }, body: '{"username":"a","password":"b"}' });
  }
});

describe('API paths (API-1)', () => {
  it('serves the new Admin and setup paths and keeps the deprecated 1.x paths working', async () => {
    mocks.login.mock.mockImplementation(async () => ({ token: 't', expiresAt: new Date(Date.now() + 3_600_000), identity: { username: 'atlas' } }));
    const body = JSON.stringify({ username: 'atlas', password: 'x' });
    for (const path of ['/api/admin/login', '/api/admin/auth/login']) {
      const reply = await send('POST', path, { headers: csrf, body });
      assert.equal(reply.status, 200, path);
      assert.match(reply.headers['set-cookie']?.[0] ?? '', /^agt_knowledge_base_session=t;/);
    }
    for (const path of ['/api/admin/session', '/api/admin/auth/session']) {
      assertMatches(JSON.parse((await send('GET', path, { headers: adminCookie })).body), { username: 'atlas', version: '1.0.0' });
    }
    for (const path of ['/api/setup/status', '/api/admin/setup/status']) {
      assert.deepEqual(JSON.parse((await send('GET', path)).body), { adminExists: true, setupPasswordConfigured: false, required: false });
    }
    assert.equal(mocks.login.mock.callCount(), 2);
  });

  it('requires the CSRF header on POST /api/setup', async () => {
    const reply = await send('POST', '/api/setup', { body: '{}' });
    assert.equal(reply.status, 403);
    assertMatches(JSON.parse(reply.body), { error: 'csrf' });
    assert.equal(mocks.setup.mock.callCount(), 0);
  });

  it('changes the Admin password with POST /api/admin/password and the deprecated PUT', async () => {
    mocks.changePassword.mock.mockImplementation(async () => ({ token: 'n', expiresAt: new Date(Date.now() + 3_600_000), identity: { username: 'atlas' } }));
    const body = JSON.stringify({ currentPassword: 'Old123456789!', password: 'New123456789!', passwordConfirmation: 'New123456789!' });
    assert.equal((await send('POST', '/api/admin/password', { headers: { ...adminCookie, ...csrf }, body })).status, 200);
    assert.equal((await send('PUT', '/api/admin/auth/password', { headers: { ...adminCookie, ...csrf }, body })).status, 200);
    assert.equal(mocks.changePassword.mock.callCount(), 2);
  });

  it('no longer answers the unprefixed paths', async () => {
    for (const path of ['/articles', '/settings', '/admin/stats']) assert.equal((await send('GET', path)).status, 404, path);
  });
});

describe('health (SRV-11)', () => {
  it('answers ok after a trivial database query, without authentication or rate limits', async () => {
    const queries: string[] = [];
    const health = buildApp(testContext({ db: fakeDatabase({ query: async (sql: string) => { queries.push(sql); return { rows: [] }; } }) }));
    try {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        const reply = await health.inject({ method: 'GET', url: '/api/health' });
        assert.equal(reply.statusCode, 200);
        assert.deepEqual(reply.json(), { status: 'ok' });
      }
      assert.deepEqual(queries[0], 'SELECT 1');
    } finally {
      await health.close();
    }
  });

  it('answers 500 when the database does not', async () => {
    const reply = await app.inject({ method: 'GET', url: '/api/health' });
    assert.equal(reply.statusCode, 500);
  });
});

describe('static files (SRV-9)', () => {
  it('serves the two entries, member pages and hashed assets, and nothing else', async () => {
    const dist = mkdtempSync(join(tmpdir(), 'agt-dist-'));
    mkdirSync(join(dist, 'assets'));
    writeFileSync(join(dist, 'index.html'), '<!doctype html><title>member</title>');
    writeFileSync(join(dist, 'admin.html'), '<!doctype html><title>admin</title>');
    writeFileSync(join(dist, 'assets', 'main-abc123.js'), 'console.log(1)');
    const site = buildApp(testContext(), { staticDir: dist });
    try {
      const home = await site.inject({ method: 'GET', url: '/' });
      assert.equal(home.statusCode, 200);
      assert.match(home.body, /member/);
      assert.equal(home.headers['cache-control'], 'no-store, no-cache, must-revalidate, max-age=0');
      assert.equal(home.headers['content-security-policy'], contentSecurityPolicy);
      assert.equal(home.headers['x-frame-options'], 'DENY');

      const admin = await site.inject({ method: 'GET', url: '/admin' });
      assert.match(admin.body, /admin/);
      assert.equal(admin.headers['x-robots-tag'], 'noindex, nofollow');
      const slash = await site.inject({ method: 'GET', url: '/admin/' });
      assert.equal(slash.statusCode, 301);
      assert.equal(slash.headers.location, '/admin');

      for (const path of ['/login', '/tags', '/articles/00000000-0000-4000-8000-000000000001', '/articles/new']) {
        assert.match((await site.inject({ method: 'GET', url: path })).body, /member/, path);
      }

      const asset = await site.inject({ method: 'GET', url: '/assets/main-abc123.js' });
      assert.equal(asset.statusCode, 200);
      assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
      assert.equal(asset.headers.pragma, undefined);
      assert.equal(asset.headers.expires, undefined);
      assert.equal(asset.headers['content-security-policy'], contentSecurityPolicy);

      for (const path of ['/admin.html', '/api-docs', '/unknown', '/assets/missing.js']) {
        const reply = await site.inject({ method: 'GET', url: path });
        assert.equal(reply.statusCode, 404, path);
        assert.match(String(reply.headers['content-type']), /^application\/json/, path);
      }
    } finally {
      await site.close();
    }
  });
});
