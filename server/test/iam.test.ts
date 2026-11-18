import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it, mock } from 'node:test';
import { ConfigError, parseConfig } from '../config.js';
import { IamClient, iamMissingName, iamStatus, parseExpiresIn } from '../iam.js';
import { rejectsMatching } from './helpers.js';

/**
 * The AGT IAM client (issue #30) against a fake IAM on a loopback port: the
 * request it sends, and how each answer maps to a traveller or an API error.
 */

interface Received {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: unknown;
}

type Responder = (request: Received, response: http.ServerResponse) => void;

const apiKey = 'iam-api-key-never-logged';
const password = 'p,a"s\'s+w\\ord';
let received: Received[] = [];
let respond: Responder = () => undefined;
const fake = http.createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const text = Buffer.concat(chunks).toString('utf8');
    const entry = { method: request.method ?? '', url: request.url ?? '', headers: request.headers, body: text ? JSON.parse(text) : undefined };
    received.push(entry);
    respond(entry, response);
  });
});
let baseUrl = '';

before(async () => {
  await new Promise<void>((resolve) => fake.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
});
after(async () => {
  fake.closeAllConnections();
  await new Promise((resolve) => fake.close(resolve));
});

function reply(status: number, body: unknown, headers: Record<string, string> = {}): Responder {
  return (_request, response) => {
    response.writeHead(status, { 'content-type': 'application/json', ...headers });
    response.end(typeof body === 'string' ? body : JSON.stringify(body));
  };
}

function verified(overrides: { authorization?: Record<string, unknown>; traveller?: Record<string, unknown>; expiresIn?: unknown } = {}) {
  return {
    authenticated: true,
    verified: true,
    token: 'iam-jwt-token',
    traveller: { travellerName: 'Atlas Walker', agtTravellerId: 'AGT-0042', agtStatus: 'Active', securityLevel: '2', ...overrides.traveller },
    applicationAuthorization: { requestedAppId: 'app01', permissionAssigned: 'Moderator', isAuthorized: true, accessNotes: '', ...overrides.authorization },
    metadata: { issuer: 'AGT-IAM', expiresIn: overrides.expiresIn ?? '24h', timestamp: '2026-11-17T12:00:00.000Z' },
  };
}

const log = { error: mock.fn((_message: string) => undefined), warn: mock.fn((_message: string) => undefined) };

function client(extraConfig = '', key: string | null = apiKey) {
  const config = parseConfig(`iam:\n  enabled: true\n  baseUrl: ${baseUrl}/iam\n  appId: app01\n  timeoutSeconds: 1\n  roleMap:\n    Moderator: Moderator\n${extraConfig}`);
  return new IamClient({ config, iamApiKey: key }, log);
}

/** Every line written to the server log; none may contain the password or the API key. */
function logged() {
  return [...log.error.mock.calls, ...log.warn.mock.calls].map(({ arguments: [message] }) => message).join('\n');
}

beforeEach(() => {
  received = [];
  respond = reply(200, verified());
  log.error.mock.resetCalls();
  log.warn.mock.resetCalls();
});

describe('IamClient', () => {
  it('posts the credentials, the App ID and the API key to <baseUrl>/api/v1/auth/verify', async () => {
    const traveller = await client().verify('Atlas Walker', password);
    assert.deepEqual(traveller, { travellerId: 'AGT-0042', travellerName: 'Atlas Walker', permission: 'Moderator', role: 'Moderator', securityLevel: 2, expiresInSeconds: 86_400 });
    assert.equal(received.length, 1);
    const [request] = received;
    assert.equal(request.method, 'POST');
    assert.equal(request.url, '/iam/api/v1/auth/verify');
    assert.equal(request.headers['x-api-key'], apiKey);
    assert.equal(request.headers['content-type'], 'application/json');
    // Quotes, commas, plus signs and backslashes reach IAM exactly as typed.
    assert.deepEqual(request.body, { identifier: 'Atlas Walker', password, appId: 'app01' });
  });

  it('maps the permission tier with iam.roleMap, else iam.defaultRole', async () => {
    respond = reply(200, verified({ authorization: { permissionAssigned: 'Contributor' } }));
    assert.equal((await client().verify('Atlas Walker', password)).role, 'Editor');
    assert.equal((await client('  defaultRole: Moderator\n').verify('Atlas Walker', password)).role, 'Moderator');
  });

  it('answers 401 invalid_credentials for a wrong name or password, without saying which', async () => {
    for (const code of ['ERR_IDENTITY_NOT_FOUND', 'ERR_INVALID_CREDENTIALS']) {
      respond = reply(401, { error: code, message: 'Invalid credentials' });
      await rejectsMatching(client().verify('Atlas Walker', password), { statusCode: 401, error: 'invalid_credentials' });
    }
    respond = reply(200, { authenticated: false });
    await rejectsMatching(client().verify('Atlas Walker', password), { statusCode: 401, error: 'invalid_credentials' });
  });

  it('answers 403 app_access_denied when the traveller is not authorized for this app', async () => {
    for (const authorization of [
      { isAuthorized: false, permissionAssigned: 'Moderator' },
      { isAuthorized: true, permissionAssigned: 'NOACCESS' },
      { isAuthorized: true, permissionAssigned: 'NONE' },
      { isAuthorized: true, permissionAssigned: '' },
    ]) {
      respond = reply(200, verified({ authorization }));
      await rejectsMatching(client().verify('Atlas Walker', password), { statusCode: 403, error: 'app_access_denied' });
    }
  });

  it('answers 503 iam_unavailable when IAM refuses the app itself, and logs only the upstream code', async () => {
    for (const [status, code] of [[401, 'UNAUTHORIZED_APP'], [401, 'INACTIVE_APP'], [401, 'INVALID_API_KEY'], [403, 'FORBIDDEN_SCOPE']] as const) {
      respond = reply(status, { code, message: `details with ${apiKey}` });
      await rejectsMatching(client().verify('Atlas Walker', password), { statusCode: 503, error: 'iam_unavailable' });
      assert.match(logged(), new RegExp(code));
    }
    assert.ok(!logged().includes(apiKey));
    assert.ok(!logged().includes(password));
  });

  it('answers 503 iam_unavailable without calling IAM while it is not configured', async () => {
    await rejectsMatching(client('', null).verify('Atlas Walker', password), { statusCode: 503, error: 'iam_unavailable' });
    assert.equal(received.length, 0);
  });

  it('passes on IAM rate limiting as 429 rate_limited with its Retry-After, and never retries', async () => {
    respond = reply(429, { error: 'RATE_LIMIT_EXCEEDED' }, { 'retry-after': '120' });
    await rejectsMatching(client().verify('Atlas Walker', password), { statusCode: 429, error: 'rate_limited', params: { retryAfterSeconds: 120 } });
    respond = reply(429, { error: 'RATE_LIMIT_EXCEEDED' });
    await rejectsMatching(client().verify('Atlas Walker', password), { statusCode: 429, params: { retryAfterSeconds: 60 } });
    assert.equal(received.length, 2);
  });

  it('answers 502 iam_bad_gateway for server errors, malformed, oversized or redirected answers', async () => {
    const answers: Responder[] = [
      reply(500, { error: 'INTERNAL' }),
      reply(400, 'not json'),
      reply(200, 'not json'),
      reply(200, { authenticated: true }),
      reply(200, verified({ traveller: { agtTravellerId: '' } })),
      reply(200, verified({ authorization: { requestedAppId: 'app02' } })),
      reply(200, { ...verified(), padding: 'x'.repeat(70 * 1024) }),
      (_request, response) => { response.writeHead(302, { location: 'https://elsewhere.example/' }); response.end(); },
    ];
    for (const answer of answers.slice(0, 1).concat(answers.slice(2))) {
      respond = answer;
      await rejectsMatching(client().verify('Atlas Walker', password), { statusCode: 502, error: 'iam_bad_gateway' });
    }
    // A 400 is IAM's own validation answer.
    respond = answers[1];
    await rejectsMatching(client().verify('Atlas Walker', password), { statusCode: 400, error: 'validation_failed' });
    assert.ok(!logged().includes(password));
  });

  it('answers 502 iam_bad_gateway when IAM cannot be reached', async () => {
    const closed = http.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const port = (closed.address() as AddressInfo).port;
    await new Promise((resolve) => closed.close(resolve));
    const unreachable = new IamClient({ config: parseConfig(`iam:\n  baseUrl: http://127.0.0.1:${port}\n  appId: app01\n`), iamApiKey: apiKey }, log);
    await rejectsMatching(unreachable.verify('Atlas Walker', password), { statusCode: 502, error: 'iam_bad_gateway' });
  });

  it('answers 504 iam_timeout when IAM does not answer within iam.timeoutSeconds', async () => {
    respond = () => undefined;
    const started = Date.now();
    await rejectsMatching(client().verify('Atlas Walker', password), { statusCode: 504, error: 'iam_timeout' });
    assert.ok(Date.now() - started < 5000);
    fake.closeAllConnections();
  });

  it('takes the security level IAM sends, and refuses the sign-in without a valid one (#70)', async () => {
    for (const [sent, level] of [['0', 0], ['5', 5], [3, 3]] as const) {
      respond = reply(200, verified({ traveller: { securityLevel: sent } }));
      assert.equal((await client().verify('Atlas Walker', password)).securityLevel, level);
    }
    for (const sent of [undefined, '', '6', '-1', '1.5', 'Restricted', ' 2', null, 7]) {
      respond = reply(200, verified({ traveller: { securityLevel: sent } }));
      await rejectsMatching(client().verify('Atlas Walker', password), { statusCode: 502, error: 'iam_bad_gateway' });
    }
    assert.match(logged(), /securityLevel/);
    assert.ok(!logged().includes('Atlas Walker'));
  });

  it('keeps at most 42 characters of the Traveller Name IAM returns', async () => {
    respond = reply(200, verified({ traveller: { travellerName: `${'🚀'.repeat(40)}abcdef` } }));
    assert.equal([...(await client().verify('Atlas Walker', password)).travellerName].length, 42);
  });
});

describe('AGT IAM configuration', () => {
  it('reports what is missing and whether sign-in is available', () => {
    const config = parseConfig('iam:\n  baseUrl: https://iam.example.com\n');
    assert.deepEqual(iamStatus({ config, iamApiKey: null }, { 'iam.enabled': true }), { enabled: true, available: false, missing: ['appId', 'apiKey'] });
    const complete = parseConfig('iam:\n  baseUrl: https://iam.example.com\n  appId: app01\n');
    assert.deepEqual(iamStatus({ config: complete, iamApiKey: 'key' }, { 'iam.enabled': false }), { enabled: false, available: false, missing: [] });
    assert.deepEqual(iamStatus({ config: complete, iamApiKey: 'key' }, { 'iam.enabled': true }), { enabled: true, available: true, missing: [] });
    assert.deepEqual(['baseUrl', 'appId', 'apiKey'].map((missing) => iamMissingName(missing as 'baseUrl')), ['iam.baseUrl', 'iam.appId', 'AGT_KNOWLEDGE_BASE_IAM_API_KEY']);
  });

  it('accepts https:// and loopback http:// base URLs only (CFG-3)', () => {
    for (const url of ['https://iam.nms-agt.com', 'https://iam.example.com/prefix', 'http://localhost:9000', 'http://127.0.0.1:9000/iam']) {
      assert.equal(parseConfig(`iam:\n  baseUrl: ${url}\n`).iam.baseUrl, url);
    }
    for (const url of ['http://iam.nms-agt.com', 'ftp://iam.example.com', 'https://user:secret@iam.example.com', 'iam.example.com']) {
      assert.throws(() => parseConfig(`iam:\n  baseUrl: ${url}\n`), (error: unknown) => error instanceof ConfigError && /iam\.baseUrl/.test(error.message), url);
    }
    assert.throws(() => parseConfig('iam:\n  roleMap:\n    Moderator: Admin\n'), /iam\.roleMap/);
    assert.throws(() => parseConfig('iam:\n  timeoutSeconds: 60\n'), /iam\.timeoutSeconds/);
    assert.throws(() => parseConfig('iam:\n  apiKey: secret\n'), /iam\.apiKey: Unexpected property/);
  });

  it('reads IAM token lifetimes', () => {
    assert.equal(parseExpiresIn('24h'), 86_400);
    assert.equal(parseExpiresIn('90m'), 5400);
    assert.equal(parseExpiresIn('3600'), 3600);
    assert.equal(parseExpiresIn(600), 600);
    assert.equal(parseExpiresIn('2d'), 172_800);
    for (const unreadable of ['soon', '', '0', -5, null, '1w']) assert.equal(parseExpiresIn(unreadable), undefined, String(unreadable));
  });
});
