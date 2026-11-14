import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { after, before, describe, it } from 'node:test';
import { buildApp, type App } from '../app.js';
import { SECURITY } from '../openapi.js';
import { apiRoutes } from '../routes.js';
import { errorCodes } from '../schemas.js';
import { parseOpenApi } from '../../src/lib/openapi.js';
import { assertMatches, testContext } from './helpers.js';

/**
 * The generated OpenAPI document (API-11, API-13): every /api/ route is in
 * it with a unique operationId, tags, a 2xx schema, the ErrorBody default and
 * the security its auth mode really needs.
 */

type Node = Record<string, unknown>;

const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;

let app: App;
let document: Node;

before(async () => {
  app = buildApp(testContext({ version: '9.8.7' }));
  const response = await app.inject({ method: 'GET', url: '/api/openapi.json' });
  assert.equal(response.statusCode, 200);
  document = response.json() as Node;
});

after(() => app.close());

function operations() {
  return Object.entries(document.paths as Record<string, Node>).flatMap(([path, item]) => methods
    .filter((method) => item[method])
    .map((method) => ({ key: `${method.toUpperCase()} ${path}`, path, method, operation: item[method] as Node })));
}

/** The security a route must declare, from the API-11 table (and the member row of the AUTH-1 deviation). */
function expectedSecurity(key: string) {
  const route = apiRoutes.find((candidate) => candidate.routeKey === key)!;
  if (route.auth === 'member') return SECURITY.member;
  if (route.auth === 'admin') return route.method === 'GET' ? SECURITY.adminRead : SECURITY.adminWrite;
  if (['POST /api/setup', 'POST /api/admin/login', 'POST /api/admin/setup', 'POST /api/admin/auth/login'].includes(key)) return SECURITY.csrfOnly;
  return SECURITY.none;
}

/** Error codes the server can send, found in HttpError calls and literal error bodies. */
function serverErrorCodes() {
  const codes = new Set<string>();
  const patterns = [/error: '([a-z][a-z_]+)'/g, /(?:HttpError|super)\(\d{3}, '([a-z][a-z_]+)'/g, /body\('([a-z][a-z_]+)'/g];
  for (const file of readdirSync('server')) {
    if (!file.endsWith('.ts')) continue;
    const source = readFileSync(`server/${file}`, 'utf8');
    for (const pattern of patterns) for (const found of source.matchAll(pattern)) codes.add(found[1]);
  }
  return codes;
}

describe('OpenAPI document', () => {
  it('is OpenAPI 3.1 with the app version (API-11, VER-2)', () => {
    assert.equal(document.openapi, '3.1.0');
    assert.deepEqual(document.info, {
      title: 'AGT Knowledge Base API',
      version: '9.8.7',
      description: (document.info as Node).description,
    });
  });

  it('lists every /api/ route of the app exactly once, and nothing else', () => {
    const documented = operations().map((operation) => operation.key);
    assert.equal(new Set(documented).size, documented.length);
    assert.deepEqual([...documented].sort(), apiRoutes.map((route) => route.routeKey).sort());
    assert.ok(apiRoutes.every((route) => route.path.startsWith('/api/')));
    // Hidden routes describe nothing: the document itself, the UI pages, OPTIONS.
    assert.ok(!documented.some((key) => key.includes('openapi.json')));
  });

  it('gives every operation a unique operationId, a tag, a summary, a 2xx schema and the ErrorBody default', () => {
    const ids = new Set<string>();
    for (const { key, operation } of operations()) {
      const id = operation.operationId as string;
      assert.match(id, /^[a-z][a-zA-Z]+$/, key);
      assert.ok(!ids.has(id), `duplicate operationId ${id}`);
      ids.add(id);
      assert.equal((operation.tags as string[] | undefined)?.length, 1, key);
      assert.ok(operation.summary, key);
      const responses = operation.responses as Record<string, Node>;
      const success = Object.keys(responses).filter((status) => status.startsWith('2'));
      assert.equal(success.length, 1, key);
      const content = responses[success[0]].content as Record<string, Node> | undefined;
      if (success[0] !== '204') assert.ok(content && Object.values(content).every((entry) => entry.schema), key);
      assert.ok(JSON.stringify(responses.default).includes('ErrorBody'), key);
    }
  });

  it('declares the security each route really needs (API-11, API-13)', () => {
    for (const { key, operation } of operations()) {
      assert.deepEqual(operation.security, expectedSecurity(key), key);
    }
    const schemes = (document.components as Node).securitySchemes as Node;
    assert.deepEqual(Object.keys(schemes).sort(), ['csrfHeader', 'memberBearer', 'sessionCookie']);
    assert.deepEqual(schemes.csrfHeader, { type: 'apiKey', in: 'header', name: 'x-agt-request', description: 'Must be "1".' });
  });

  it('marks the 1.x paths deprecated and names their replacements', () => {
    for (const route of apiRoutes) {
      const operation = (document.paths as Record<string, Node>)[route.path][route.method.toLowerCase()] as Node;
      assert.equal(operation.deprecated === true, route.replacedBy !== undefined, route.routeKey);
      if (route.replacedBy) assert.ok(apiRoutes.some((candidate) => candidate.routeKey === route.replacedBy && !candidate.replacedBy), route.routeKey);
    }
  });

  it('documents the error body with its deprecated 1.x fields and every error code the server sends', () => {
    const schemas = (document.components as Node).schemas as Record<string, Node>;
    const errorBody = Object.values(schemas).find((schema) => schema.title === 'ErrorBody' || (schema.properties as Node | undefined)?.error) as Node;
    const properties = errorBody.properties as Record<string, Node>;
    assert.deepEqual((errorBody.required as string[]).sort(), ['code', 'error', 'message']);
    assert.equal(properties.code.deprecated, true);
    assert.equal(properties.issues.deprecated, true);
    const documented = new Set(errorCodes as readonly string[]);
    for (const code of serverErrorCodes()) assert.ok(documented.has(code), `${code} is not in errorCodes`);
    for (const code of documented) assert.ok(String(properties.error.description).includes(`\`${code}\``), code);
  });

  it('lists every error code in docs/API.md', () => {
    const guide = readFileSync('docs/API.md', 'utf8');
    for (const code of errorCodes) assert.ok(guide.includes(`\`${code}\``), code);
  });
});

describe('the admin panel\'s API reference', () => {
  it('reads the generated document', () => {
    const reference = parseOpenApi(document);
    assert.equal(reference.title, 'AGT Knowledge Base API');
    assert.equal(reference.version, '9.8.7');
    assert.deepEqual(reference.groups.map((group) => group.name), ['public', 'auth', 'articles', 'tags', 'admin']);
    const all = reference.groups.flatMap((group) => group.operations);
    assert.equal(all.length, apiRoutes.length);
    const find = (method: string, path: string) => all.find((operation) => operation.method === method && operation.path === path)!;
    assertMatches(find('PUT', '/api/admin/settings'), { auth: 'admin', csrfHeader: true, deprecated: false });
    assertMatches(find('POST', '/api/admin/login'), { auth: 'none', csrfHeader: true });
    assertMatches(find('GET', '/api/articles'), { auth: 'none', csrfHeader: false });
    assertMatches(find('POST', '/api/articles'), { auth: 'member', csrfHeader: false });
    assertMatches(find('POST', '/api/admin/auth/login'), { deprecated: true });
    const body = find('POST', '/api/articles').requestBody!;
    assert.deepEqual(body.fields.map((field) => field.name), ['title', 'content', 'tagIds', 'visibility', 'version']);
    assert.ok(find('GET', '/api/articles').parameters.some((parameter) => parameter.name === 'cursor' && parameter.location === 'query'));
  });
});
