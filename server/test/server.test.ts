import assert from 'node:assert/strict';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import type { AdminSessionResult } from '../admin-auth.js';
import { buildApp, type App } from '../app.js';
import type { AdminIdentity, ApiRequest, ApiResponse } from '../routes.js';
import { RateLimiter } from '../rate-limit.js';
import { routeKeys } from '../routes.js';
import type { LocalSessionUser } from '../local-auth.js';
import { assertCalledWith, assertMatches, callArgs, match, testContext } from './helpers.js';

/** The HTTP pipeline: session separation, CSRF, cookies, body limits and rate limits, over a real socket. */

const mocks = {
  session: mock.fn(async (_token: string): Promise<AdminIdentity | null> => null),
  login: mock.fn(async (_username: string, _password: string): Promise<AdminSessionResult> => { throw new Error('unused'); }),
  logout: mock.fn(async (_token: string) => undefined),
  setup: mock.fn(async (_input: unknown): Promise<AdminSessionResult> => { throw new Error('unused'); }),
  setupStatus: mock.fn(async () => ({ required: false, setupPasswordConfigured: false })),
  changePassword: mock.fn(async (_current: string, _password: string): Promise<AdminSessionResult> => { throw new Error('unused'); }),
  verifyToken: mock.fn(async (_token: string): Promise<LocalSessionUser> => { throw new Error('unused'); }),
  authenticateLocalUser: mock.fn(async (_identifier: string, _password: string): Promise<LocalSessionUser | null> => null),
  handleRequest: mock.fn(async (_request: ApiRequest): Promise<ApiResponse> => ({ statusCode: 200, headers: {}, body: '{"ok":"member"}' })),
  handleAdminRequest: mock.fn(async (_request: ApiRequest): Promise<ApiResponse> => ({ statusCode: 200, headers: {}, body: '{"ok":"admin"}' })),
  getEffective: mock.fn(async () => ({ backupMaxBytes: 1000 })),
};

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }

let app: App;
let port: number;
let now = 0;

async function start(config = '', setupPassword: string | null = null) {
  await app?.close();
  app = buildApp(testContext({ config, setupPassword }), {
    rateLimiter: new RateLimiter(() => now),
    handlers: { request: mocks.handleRequest, admin: mocks.handleAdminRequest },
    services: {
      localAuth: { authenticate: mocks.authenticateLocalUser, issueToken: () => 'member-token', verifyToken: mocks.verifyToken },
      adminAuth: {
        session: mocks.session,
        login: mocks.login,
        logout: mocks.logout,
        setup: mocks.setup,
        setupStatus: mocks.setupStatus,
        changePassword: mocks.changePassword,
      },
      settings: { getEffective: mocks.getEffective as never },
    },
  });
  await app.listen({ host: '127.0.0.1', port: 0 });
  port = (app.server.address() as AddressInfo).port;
}

function send(method: string, path: string, options: { headers?: Record<string, string>; body?: string | Buffer } = {}) {
  // Node's client frames bodies of every method only when told the length (or chunking).
  const headers = options.body === undefined || options.headers?.['transfer-encoding']
    ? options.headers
    : { 'content-length': String(Buffer.byteLength(options.body)), ...options.headers };
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

const moderatorToken = { authorization: 'Bearer moderator-token' };
const adminCookie = { cookie: 'agt_admin_session=admin-token' };
const csrf = { 'x-agt-request': '1' };

beforeEach(async () => {
  now += 24 * 60 * 60 * 1000;
  for (const fn of Object.values(mocks)) {
    fn.mock.restore();
    fn.mock.resetCalls();
  }
  mocks.verifyToken.mock.mockImplementation(async () => ({
    sub: 'moderator-sub', username: 'mod', displayName: 'Moderator', role: 'Moderator', sessionVersion: 1,
  }));
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
  it('refuses every admin-session route with a member bearer token, including a Moderator\'s', async () => {
    const adminRoutes = routeKeys.filter((key) => key.includes(' /admin/')
      && !['GET /admin/setup/status', 'POST /admin/setup', 'POST /admin/auth/login'].includes(key));
    for (const key of adminRoutes) {
      const [method, path] = concrete(key);
      const reply = await send(method, path, { headers: { ...moderatorToken, ...csrf }, body: method === 'GET' ? undefined : '{}' });
      assert.equal(reply.status, 401, key);
    }
    assert.equal(mocks.verifyToken.mock.callCount(), 0);
    assert.equal(mocks.handleAdminRequest.mock.callCount(), 0);
  });

  it('refuses member routes with only an Admin cookie', async () => {
    for (const key of routeKeys.filter((routeKey) => !routeKey.includes(' /admin/'))) {
      const [method, path] = concrete(key);
      const reply = await send(method, path, { headers: adminCookie, body: method === 'GET' ? undefined : '{}' });
      if (['GET /settings', 'GET /articles', 'GET /articles/{id}', 'GET /tags'].includes(key)) {
        // Public reads are dispatched without any identity.
        assert.equal(reply.status, 200, key);
        continue;
      }
      if (key === 'POST /auth/login') continue;
      assert.equal(reply.status, 401, key);
    }
    assert.equal(mocks.session.mock.callCount(), 0);
    for (const call of mocks.handleRequest.mock.calls) assert.equal(call.arguments[0].actor, null);
  });

  it('passes the Admin, and never a member actor, to admin handlers', async () => {
    const reply = await send('GET', '/admin/stats', { headers: { ...adminCookie, ...moderatorToken } });
    assert.equal(reply.status, 200);
    assertMatches(callArgs(mocks.handleAdminRequest)[0], { admin: { username: 'atlas' }, actor: null });
    assert.equal(mocks.verifyToken.mock.callCount(), 0);
  });

  it('passes the signed-in member as the actor to member handlers', async () => {
    const reply = await send('POST', '/articles', { headers: moderatorToken, body: '{}' });
    assert.equal(reply.status, 200);
    assertCalledWith(mocks.verifyToken, 'moderator-token');
    assertMatches(callArgs(mocks.handleRequest)[0], {
      routeKey: 'POST /articles',
      actor: { sub: 'moderator-sub', role: 'Moderator', displayName: 'Moderator' },
      body: '{}',
    });
  });

  it('refuses an invalid member token', async () => {
    mocks.verifyToken.mock.mockImplementation(async () => { throw new Error('Invalid session token.'); });
    const reply = await send('GET', '/auth/session', { headers: moderatorToken });
    assert.equal(reply.status, 401);
    assert.deepEqual(JSON.parse(reply.body), { code: 'UNAUTHENTICATED', message: 'Invalid or expired authentication token.' });
  });

  it('clears an unknown or expired Admin cookie', async () => {
    const reply = await send('GET', '/admin/auth/session', { headers: { cookie: 'agt_admin_session=expired' } });
    assert.equal(reply.status, 401);
    assert.match(reply.headers['set-cookie']?.[0] ?? '', /^agt_admin_session=; Path=\/api\/admin; Max-Age=0/);
  });
});

describe('CSRF protection', () => {
  it('requires x-agt-request on every non-GET admin request, before authentication', async () => {
    for (const [method, path] of [['POST', '/admin/auth/login'], ['POST', '/admin/setup'], ['PUT', '/admin/settings'], ['POST', '/admin/auth/logout'], ['DELETE', '/admin/users/00000000-0000-4000-8000-000000000001']]) {
      const reply = await send(method, path, { headers: adminCookie, body: '{}' });
      assert.equal(reply.status, 403, path);
      assertMatches(JSON.parse(reply.body), { code: 'CSRF_HEADER_REQUIRED' });
    }
    assert.equal(mocks.session.mock.callCount(), 0);
    assert.equal((await send('PUT', '/admin/settings', { headers: { ...adminCookie, ...csrf }, body: '{}' })).status, 200);
  });

  it('does not require the header on member routes or admin reads', async () => {
    assert.equal((await send('POST', '/articles', { headers: moderatorToken, body: '{}' })).status, 200);
    assert.equal((await send('GET', '/admin/stats', { headers: adminCookie })).status, 200);
  });

  it('never allows credentialed cross-origin requests', async () => {
    const reply = await send('OPTIONS', '/admin/settings', { headers: { origin: 'https://evil.example' } });
    assert.equal(reply.status, 204);
    assert.equal(reply.headers['access-control-allow-credentials'], undefined);
    assert.ok(!(reply.headers['access-control-allow-headers'] ?? '').includes('x-agt-request'));
    assert.equal(reply.headers['access-control-allow-origin'], 'http://localhost:8080');
  });
});

describe('Admin session cookies', () => {
  it('sets an HttpOnly, SameSite=Strict session cookie on sign-in and clears it on sign-out', async () => {
    mocks.login.mock.mockImplementation(async () => ({ token: 'new-token', expiresAt: new Date(Date.now() + 3_600_000), admin: { username: 'atlas' } }));
    const login = await send('POST', '/admin/auth/login', { headers: csrf, body: JSON.stringify({ username: 'atlas', password: 'Permanent123!' }) });
    assert.equal(login.status, 200);
    assert.deepEqual(JSON.parse(login.body), { username: 'atlas', setupPasswordSet: false });
    assert.match(login.headers['set-cookie']?.[0] ?? '', /^agt_admin_session=new-token; Path=\/api\/admin; Max-Age=\d+; HttpOnly; SameSite=Strict$/);
    assert.ok(!login.body.includes('new-token'));

    const logout = await send('POST', '/admin/auth/logout', { headers: { ...adminCookie, ...csrf } });
    assert.equal(logout.status, 204);
    assertCalledWith(mocks.logout, 'admin-token');
    assert.match(logout.headers['set-cookie']?.[0] ?? '', /Max-Age=0/);
  });

  it('marks the cookie Secure when the configured origin is HTTPS', async () => {
    await start('server:\n  frontendOrigin: https://kb.example.org\n');
    mocks.login.mock.mockImplementation(async () => ({ token: 't', expiresAt: new Date(Date.now() + 3_600_000), admin: { username: 'atlas' } }));
    const login = await send('POST', '/admin/auth/login', { headers: csrf, body: JSON.stringify({ username: 'atlas', password: 'x' }) });
    assert.match(login.headers['set-cookie']?.[0] ?? '', /; Secure$/);
  });

  it('trusts X-Forwarded-Proto only from a trusted proxy', async () => {
    mocks.login.mock.mockImplementation(async () => ({ token: 't', expiresAt: new Date(Date.now() + 3_600_000), admin: { username: 'atlas' } }));
    const headers = { ...csrf, 'x-forwarded-proto': 'https' };
    const body = JSON.stringify({ username: 'atlas', password: 'x' });
    assert.doesNotMatch((await send('POST', '/admin/auth/login', { headers, body })).headers['set-cookie']?.[0] ?? '', /Secure/);
    await start('server:\n  trustProxy: 1\n');
    assert.match((await send('POST', '/admin/auth/login', { headers, body })).headers['set-cookie']?.[0] ?? '', /; Secure$/);
  });

  it('reports a still-configured setup password so the dashboard can remind the Admin', async () => {
    await start('', 'still-here');
    const reply = await send('GET', '/admin/auth/session', { headers: adminCookie });
    assert.deepEqual(JSON.parse(reply.body), { username: 'atlas', setupPasswordSet: true });
  });
});

describe('request body limits', () => {
  it('rejects an anonymous upload before reading its body', async () => {
    const reply = await new Promise<Reply>((resolve, reject) => {
      const request = httpRequest({
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/admin/backup/restore?action=preview',
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
    assert.equal(mocks.getEffective.mock.callCount(), 0);
    assert.equal(mocks.handleAdminRequest.mock.callCount(), 0);
  });

  it('rejects an authenticated upload over backup.maxBytes with 413', async () => {
    const reply = await send('POST', '/admin/backup/restore?action=preview', {
      headers: { ...adminCookie, ...csrf, 'content-type': 'application/zip' },
      body: Buffer.alloc(1001),
    });
    assert.equal(reply.status, 413);
    assertMatches(JSON.parse(reply.body), { code: 'BODY_TOO_LARGE' });
    assert.equal(mocks.handleAdminRequest.mock.callCount(), 0);
  });

  it('rejects an upload over backup.maxBytes that does not declare its length', async () => {
    const reply = await send('POST', '/admin/backup/restore?action=preview', {
      headers: { ...adminCookie, ...csrf, 'content-type': 'application/zip', 'transfer-encoding': 'chunked' },
      body: Buffer.alloc(1001),
    });
    assert.equal(reply.status, 413);
    assert.equal(mocks.handleAdminRequest.mock.callCount(), 0);
  });

  it('passes an upload within backup.maxBytes to the handler as raw bytes', async () => {
    const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]);
    await send('POST', '/admin/backup/restore?action=preview', { headers: { ...adminCookie, ...csrf }, body: archive });
    const [request] = callArgs(mocks.handleAdminRequest) as [ApiRequest];
    assert.equal(Buffer.compare(request.rawBody!, archive), 0);
    assert.equal(request.body, undefined);
    assert.deepEqual({ ...request.query }, { action: 'preview' });
  });

  it('keeps the default 1 MB limit on other routes', async () => {
    const reply = await send('POST', '/articles', { headers: moderatorToken, body: 'x'.repeat(1_000_001) });
    assert.equal(reply.status, 413);
    assertMatches(JSON.parse(reply.body), { code: 'BODY_TOO_LARGE', message: 'Request body is too large.' });
  });
});

describe('error bodies', () => {
  it('answers unknown routes with the JSON error body', async () => {
    const reply = await send('GET', '/nope');
    assert.equal(reply.status, 404);
    assert.deepEqual(JSON.parse(reply.body), { code: 'NOT_FOUND', message: 'Route not found.' });
    assert.match(String(reply.headers['content-type']), /^application\/json/);
  });

  it('rejects malformed JSON on sign-in', async () => {
    const reply = await send('POST', '/auth/login', { body: '{' });
    assert.equal(reply.status, 400);
    assert.deepEqual(JSON.parse(reply.body), { code: 'INVALID_JSON', message: 'The request body must contain valid JSON.' });
  });

  it('answers sign-in without credentials with one short message', async () => {
    const reply = await send('POST', '/auth/login', { body: '{}' });
    assert.equal(reply.status, 400);
    assert.deepEqual(JSON.parse(reply.body), { code: 'VALIDATION_ERROR', message: 'Username and password are required.' });
  });

  it('hides unexpected errors behind a generic 500', async () => {
    mocks.handleRequest.mock.mockImplementation(async () => { throw new Error('database password is wrong'); });
    const reply = await send('GET', '/settings');
    assert.equal(reply.status, 500);
    assert.deepEqual(JSON.parse(reply.body), { code: 'INTERNAL_ERROR', message: 'The archive service encountered an unexpected error.' });
  });
});

describe('rate limits', () => {
  it('limits member sign-in per client and reports Retry-After', async () => {
    const body = JSON.stringify({ username: 'apollo', password: 'wrong' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      assert.equal((await send('POST', '/auth/login', { body })).status, 401);
    }
    const limited = await send('POST', '/auth/login', { body });
    assert.equal(limited.status, 429);
    assertMatches(JSON.parse(limited.body), { code: 'RATE_LIMITED' });
    assert.ok(Number(limited.headers['retry-after']) > 0);
    assert.equal(mocks.authenticateLocalUser.mock.callCount(), 5);
  });

  it('counts clients behind a trusted proxy by their forwarded address', async () => {
    await start('server:\n  trustProxy: 1\nrateLimits:\n  login:\n    max: 1\n');
    const body = JSON.stringify({ username: 'apollo', password: 'wrong' });
    const from = (address: string) => ({ 'x-forwarded-for': address });
    assert.equal((await send('POST', '/auth/login', { body, headers: from('203.0.113.9') })).status, 401);
    assert.equal((await send('POST', '/auth/login', { body, headers: from('203.0.113.9') })).status, 429);
    // Another client, and a forged left-most entry, are counted by the address the proxy saw.
    assert.equal((await send('POST', '/auth/login', { body, headers: from('198.51.100.1') })).status, 401);
    assert.equal((await send('POST', '/auth/login', { body, headers: from('203.0.113.9, 198.51.100.7') })).status, 401);
  });

  it('ignores X-Forwarded-For unless the proxy is trusted', async () => {
    await start('rateLimits:\n  login:\n    max: 1\n');
    const body = JSON.stringify({ username: 'apollo', password: 'wrong' });
    assert.equal((await send('POST', '/auth/login', { body, headers: { 'x-forwarded-for': '203.0.113.1' } })).status, 401);
    assert.equal((await send('POST', '/auth/login', { body, headers: { 'x-forwarded-for': '203.0.113.2' } })).status, 429);
  });

  it('applies the configured Admin sign-in limit before checking credentials', async () => {
    await start('rateLimits:\n  adminLogin:\n    max: 1\n');
    mocks.login.mock.mockImplementation(async () => { throw new Error('x'); });
    await send('POST', '/admin/auth/login', { headers: csrf, body: '{"username":"a","password":"b"}' });
    const limited = await send('POST', '/admin/auth/login', { headers: csrf, body: '{"username":"a","password":"b"}' });
    assert.equal(limited.status, 429);
    assert.equal(mocks.login.mock.callCount(), 1);
  });

  it('returns the member token and profile on successful sign-in without the session version', async () => {
    mocks.authenticateLocalUser.mock.mockImplementation(async () => ({ sub: 's', username: 'apollo', displayName: 'Apollo', role: 'Editor', sessionVersion: 3 }));
    const reply = await send('POST', '/auth/login', { body: JSON.stringify({ username: 'apollo', password: 'Permanent123!' }) });
    assert.deepEqual(JSON.parse(reply.body), { token: 'member-token', user: { sub: 's', username: 'apollo', displayName: 'Apollo', role: 'Editor' } });
  });

  it('sends the member a profile from the session route', async () => {
    const reply = await send('GET', '/auth/session', { headers: moderatorToken });
    assertMatches(JSON.parse(reply.body), { sub: 'moderator-sub', username: 'mod', role: 'Moderator', displayName: match.any(String) });
    assert.ok(!reply.body.includes('sessionVersion'));
  });
});
