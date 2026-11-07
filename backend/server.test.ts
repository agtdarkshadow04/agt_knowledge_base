// @vitest-environment node
import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
  setup: vi.fn(),
  setupStatus: vi.fn(),
  changePassword: vi.fn(),
  authenticate: vi.fn(),
  authenticateLocalUser: vi.fn(),
  handleRequest: vi.fn(),
  handleAdminRequest: vi.fn(),
  getEffective: vi.fn(),
}));

vi.mock('./admin-auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./admin-auth.js')>();
  return {
    ...actual,
    AdminAuthService: class {
      session = mocks.session;
      login = mocks.login;
      logout = mocks.logout;
      setup = mocks.setup;
      setupStatus = mocks.setupStatus;
      changePassword = mocks.changePassword;
    },
  };
});
vi.mock('./auth.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./auth.js')>();
  return { ...actual, authenticate: mocks.authenticate };
});
vi.mock('./local-auth.js', () => ({
  authenticateLocalUser: mocks.authenticateLocalUser,
  issueLocalToken: () => 'member-token',
}));
vi.mock('./handler.js', () => ({ handleRequest: mocks.handleRequest }));
vi.mock('./admin-handler.js', () => ({ handleAdminRequest: mocks.handleAdminRequest }));
vi.mock('./settings-service.js', () => ({ SettingsService: class { getEffective = mocks.getEffective; } }));

import { parseConfig, setConfigForTests } from './config.js';
import { RateLimiter } from './rate-limit.js';
import { routeKeys } from './routes.js';
import { createApiListener } from './server.js';

interface Reply { status: number; headers: IncomingHttpHeaders; body: string }

let server: Server;
let port: number;
let now = 0;

function send(method: string, path: string, options: { headers?: Record<string, string>; body?: string | Buffer } = {}) {
  return new Promise<Reply>((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path, headers: options.headers }, (response) => {
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

function useConfig(text = '') {
  setConfigForTests({ path: '/app/config.yaml', text, config: parseConfig(text) });
}

beforeAll(async () => {
  useConfig();
  const listener = createApiListener({ rateLimiter: new RateLimiter(() => now) });
  server = createServer((request, response) => { void listener(request, response); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  setConfigForTests(undefined);
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  useConfig();
  now += 24 * 60 * 60 * 1000;
  Object.values(mocks).forEach((mock) => mock.mockReset());
  mocks.authenticate.mockResolvedValue({ sub: 'moderator-sub', username: 'mod', displayName: 'Moderator', role: 'Moderator' });
  mocks.session.mockImplementation(async (token: string) => (token === 'admin-token' ? { username: 'atlas' } : null));
  mocks.handleRequest.mockResolvedValue({ statusCode: 200, headers: {}, body: '{"ok":"member"}' });
  mocks.handleAdminRequest.mockResolvedValue({ statusCode: 200, headers: {}, body: '{"ok":"admin"}' });
  mocks.getEffective.mockResolvedValue({ backupMaxBytes: 1000 });
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
      expect(reply.status, key).toBe(401);
    }
    expect(mocks.authenticate).not.toHaveBeenCalled();
    expect(mocks.handleAdminRequest).not.toHaveBeenCalled();
  });

  it('refuses member routes with only an Admin cookie', async () => {
    for (const key of routeKeys.filter((routeKey) => !routeKey.includes(' /admin/'))) {
      const [method, path] = concrete(key);
      const reply = await send(method, path, { headers: adminCookie, body: method === 'GET' ? undefined : '{}' });
      if (['GET /settings', 'GET /articles', 'GET /articles/{id}', 'GET /tags'].includes(key)) {
        // Public reads are dispatched without any identity.
        expect(reply.status, key).toBe(200);
        continue;
      }
      if (key === 'POST /auth/login') continue;
      expect(reply.status, key).toBe(401);
    }
    expect(mocks.session).not.toHaveBeenCalled();
    for (const [request] of mocks.handleRequest.mock.calls) expect(request.actor).toBeNull();
  });

  it('passes the Admin, and never a member actor, to admin handlers', async () => {
    const reply = await send('GET', '/admin/stats', { headers: { ...adminCookie, ...moderatorToken } });
    expect(reply.status).toBe(200);
    expect(mocks.handleAdminRequest).toHaveBeenCalledWith(expect.objectContaining({ admin: { username: 'atlas' }, actor: null }));
    expect(mocks.authenticate).not.toHaveBeenCalled();
  });

  it('clears an unknown or expired Admin cookie', async () => {
    const reply = await send('GET', '/admin/auth/session', { headers: { cookie: 'agt_admin_session=expired' } });
    expect(reply.status).toBe(401);
    expect(reply.headers['set-cookie']?.[0]).toMatch(/^agt_admin_session=; Path=\/api\/admin; Max-Age=0/);
  });
});

describe('CSRF protection', () => {
  it('requires x-agt-request on every non-GET admin request, before authentication', async () => {
    for (const [method, path] of [['POST', '/admin/auth/login'], ['POST', '/admin/setup'], ['PUT', '/admin/settings'], ['POST', '/admin/auth/logout'], ['DELETE', '/admin/users/00000000-0000-4000-8000-000000000001']]) {
      const reply = await send(method, path, { headers: adminCookie, body: '{}' });
      expect(reply.status, path).toBe(403);
      expect(JSON.parse(reply.body)).toMatchObject({ code: 'CSRF_HEADER_REQUIRED' });
    }
    expect(mocks.session).not.toHaveBeenCalled();
    expect((await send('PUT', '/admin/settings', { headers: { ...adminCookie, ...csrf }, body: '{}' })).status).toBe(200);
  });

  it('does not require the header on member routes or admin reads', async () => {
    expect((await send('POST', '/articles', { headers: moderatorToken, body: '{}' })).status).toBe(200);
    expect((await send('GET', '/admin/stats', { headers: adminCookie })).status).toBe(200);
  });

  it('never allows credentialed cross-origin requests', async () => {
    const reply = await send('OPTIONS', '/admin/settings', { headers: { origin: 'https://evil.example' } });
    expect(reply.headers['access-control-allow-credentials']).toBeUndefined();
    expect(reply.headers['access-control-allow-headers']).not.toContain('x-agt-request');
    expect(reply.headers['access-control-allow-origin']).toBe('http://localhost:8080');
  });
});

describe('Admin session cookies', () => {
  it('sets an HttpOnly, SameSite=Strict session cookie on sign-in and clears it on sign-out', async () => {
    mocks.login.mockResolvedValue({ token: 'new-token', expiresAt: new Date(Date.now() + 3_600_000), admin: { username: 'atlas' } });
    const login = await send('POST', '/admin/auth/login', { headers: csrf, body: JSON.stringify({ username: 'atlas', password: 'Permanent123!' }) });
    expect(login.status).toBe(200);
    expect(JSON.parse(login.body)).toEqual({ username: 'atlas', setupPasswordSet: false });
    expect(login.headers['set-cookie']?.[0]).toMatch(/^agt_admin_session=new-token; Path=\/api\/admin; Max-Age=\d+; HttpOnly; SameSite=Strict$/);
    expect(login.body).not.toContain('new-token');

    const logout = await send('POST', '/admin/auth/logout', { headers: { ...adminCookie, ...csrf } });
    expect(logout.status).toBe(204);
    expect(mocks.logout).toHaveBeenCalledWith('admin-token');
    expect(logout.headers['set-cookie']?.[0]).toMatch(/Max-Age=0/);
  });

  it('marks the cookie Secure when the configured origin is HTTPS', async () => {
    useConfig('server:\n  frontendOrigin: https://kb.example.org\n');
    mocks.login.mockResolvedValue({ token: 't', expiresAt: new Date(Date.now() + 3_600_000), admin: { username: 'atlas' } });
    const login = await send('POST', '/admin/auth/login', { headers: csrf, body: JSON.stringify({ username: 'atlas', password: 'x' }) });
    expect(login.headers['set-cookie']?.[0]).toMatch(/; Secure$/);
  });

  it('trusts X-Forwarded-Proto only from a trusted proxy', async () => {
    mocks.login.mockResolvedValue({ token: 't', expiresAt: new Date(Date.now() + 3_600_000), admin: { username: 'atlas' } });
    const headers = { ...csrf, 'x-forwarded-proto': 'https' };
    const body = JSON.stringify({ username: 'atlas', password: 'x' });
    expect((await send('POST', '/admin/auth/login', { headers, body })).headers['set-cookie']?.[0]).not.toMatch(/Secure/);
    useConfig('server:\n  trustProxy: 1\n');
    expect((await send('POST', '/admin/auth/login', { headers, body })).headers['set-cookie']?.[0]).toMatch(/; Secure$/);
  });

  it('reports a still-configured setup password so the dashboard can remind the Admin', async () => {
    process.env.AGT_SETUP_PASSWORD = 'still-here';
    try {
      const reply = await send('GET', '/admin/auth/session', { headers: adminCookie });
      expect(JSON.parse(reply.body)).toEqual({ username: 'atlas', setupPasswordSet: true });
    } finally {
      delete process.env.AGT_SETUP_PASSWORD;
    }
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
    expect(reply.status).toBe(401);
    expect(mocks.getEffective).not.toHaveBeenCalled();
    expect(mocks.handleAdminRequest).not.toHaveBeenCalled();
  });

  it('rejects an authenticated upload over backup.maxBytes with 413', async () => {
    const reply = await send('POST', '/admin/backup/restore?action=preview', {
      headers: { ...adminCookie, ...csrf, 'content-type': 'application/zip' },
      body: Buffer.alloc(1001),
    });
    expect(reply.status).toBe(413);
    expect(mocks.handleAdminRequest).not.toHaveBeenCalled();
  });

  it('passes an upload within backup.maxBytes to the handler as raw bytes', async () => {
    const archive = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff]);
    await send('POST', '/admin/backup/restore?action=preview', { headers: { ...adminCookie, ...csrf }, body: archive });
    const [request] = mocks.handleAdminRequest.mock.calls[0];
    expect(Buffer.compare(request.rawBody, archive)).toBe(0);
    expect(request.body).toBeUndefined();
    expect(request.query).toEqual({ action: 'preview' });
  });

  it('keeps the default 1 MB limit on other routes', async () => {
    const reply = await send('POST', '/articles', { headers: moderatorToken, body: 'x'.repeat(1_000_001) });
    expect(reply.status).toBe(413);
  });
});

describe('rate limits', () => {
  it('limits member sign-in per client and reports Retry-After', async () => {
    mocks.authenticateLocalUser.mockResolvedValue(null);
    const body = JSON.stringify({ username: 'apollo', password: 'wrong' });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect((await send('POST', '/auth/login', { body })).status).toBe(401);
    }
    const limited = await send('POST', '/auth/login', { body });
    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    expect(mocks.authenticateLocalUser).toHaveBeenCalledTimes(5);
  });

  it('applies the configured Admin sign-in limit before checking credentials', async () => {
    useConfig('rateLimits:\n  adminLogin:\n    max: 1\n');
    mocks.login.mockRejectedValue(Object.assign(new Error('x'), { name: 'AppError' }));
    await send('POST', '/admin/auth/login', { headers: csrf, body: '{"username":"a","password":"b"}' });
    const limited = await send('POST', '/admin/auth/login', { headers: csrf, body: '{"username":"a","password":"b"}' });
    expect(limited.status).toBe(429);
    expect(mocks.login).toHaveBeenCalledTimes(1);
  });

  it('returns the member token and profile on successful sign-in without the session version', async () => {
    mocks.authenticateLocalUser.mockResolvedValue({ sub: 's', username: 'apollo', displayName: 'Apollo', role: 'Editor', sessionVersion: 3 });
    const reply = await send('POST', '/auth/login', { body: JSON.stringify({ username: 'apollo', password: 'Permanent123!' }) });
    expect(JSON.parse(reply.body)).toEqual({ token: 'member-token', user: { sub: 's', username: 'apollo', displayName: 'Apollo', role: 'Editor' } });
  });
});
