import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { apiRoutes, routeKeys } from '../routes.js';
import { assertEquals, assertMatches, match, matches } from './helpers.js';

/**
 * Keeps docs/openapi.yaml (public and member routes) and docs/openapi-admin.yaml
 * (Admin routes) in sync with the route table, and the documented error codes
 * in sync with the codes the backend can return.
 */

type Node = Record<string, unknown>;

const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
const schemeForAuth = { none: undefined, member: 'memberBearer', admin: 'adminCookie' } as const;

/** Reads a file relative to the repository root, where npm runs the tests. */
function read(path: string) {
  return readFileSync(path, 'utf8');
}

const specs = {
  member: parse(read('docs/openapi.yaml')) as Node,
  admin: parse(read('docs/openapi-admin.yaml')) as Node,
};

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolve(spec: Node, value: unknown): Node {
  let current = value;
  while (isNode(current) && typeof current.$ref === 'string') {
    let target: unknown = spec;
    for (const part of current.$ref.replace(/^#\//, '').split('/')) target = isNode(target) ? target[part] : undefined;
    if (!isNode(target)) throw new Error(`Unresolved reference ${current.$ref}`);
    current = target;
  }
  return current as Node;
}

interface Operation {
  spec: keyof typeof specs;
  key: string;
  path: string;
  method: string;
  operation: Node;
  parameters: Node[];
}

function operations(name: keyof typeof specs): Operation[] {
  const spec = specs[name];
  return Object.entries(spec.paths as Node).flatMap(([path, rawItem]) => {
    const item = resolve(spec, rawItem);
    return methods.filter((method) => isNode(item[method])).map((method) => {
      const operation = item[method] as Node;
      const parameters = [...(item.parameters as unknown[] ?? []), ...(operation.parameters as unknown[] ?? [])]
        .map((parameter) => resolve(spec, parameter));
      return { spec: name, key: `${method.toUpperCase()} ${path}`, path, method, operation, parameters };
    });
  });
}

const documented = [...operations('member'), ...operations('admin')];

function securitySchemes(spec: Node, operation: Node) {
  const security = (operation.security ?? spec.security ?? []) as Node[];
  return security.flatMap((requirement) => Object.keys(requirement));
}

function collectRefs(value: unknown, refs: string[] = []) {
  if (Array.isArray(value)) value.forEach((entry) => collectRefs(entry, refs));
  else if (isNode(value)) {
    if (typeof value.$ref === 'string') refs.push(value.$ref);
    Object.values(value).forEach((entry) => collectRefs(entry, refs));
  }
  return refs;
}

/** Error codes the backend can send, found in HttpError calls and literal error bodies. */
function backendErrorCodes() {
  const codes = new Set<string>();
  const patterns = [/code: '([A-Z][A-Z_]+)'/g, /(?:HttpError|super)\(\d{3}, '([A-Z][A-Z_]+)'/g, /pathId\([^)]*'([A-Z][A-Z_]+)'\)/g];
  for (const file of readdirSync('server')) {
    if (!file.endsWith('.ts')) continue;
    const source = read(`server/${file}`);
    for (const pattern of patterns) for (const found of source.matchAll(pattern)) codes.add(found[1]);
  }
  return codes;
}

function documentedErrorCodes() {
  const codes = new Set<string>();
  for (const { spec, operation } of documented) {
    for (const response of Object.values(operation.responses as Node)) {
      for (const code of (resolve(specs[spec], response)['x-error-codes'] as string[] | undefined) ?? []) codes.add(code);
    }
  }
  return codes;
}

describe('OpenAPI description', () => {
  it('uses OpenAPI 3.1 with the /api server in both files', () => {
    for (const spec of Object.values(specs)) {
      assert.equal(spec.openapi, '3.1.0');
      assertEquals(spec.servers, [match.objectContaining({ url: '/api' })]);
    }
  });

  it('documents exactly the routes in routes.ts, once each', () => {
    const keys = documented.map((operation) => operation.key);
    assert.equal(new Set(keys).size, keys.length);
    assert.deepEqual([...keys].sort(), [...routeKeys].sort());
  });

  it('keeps Admin routes in the admin file and every other route in the member file', () => {
    for (const operation of documented) {
      const route = apiRoutes.find((candidate) => candidate.routeKey === operation.key);
      assert.equal(route?.admin, operation.spec === 'admin', operation.key);
    }
  });

  it('declares security that matches each route\'s auth mode and rate limit', () => {
    for (const operation of documented) {
      const route = apiRoutes.find((candidate) => candidate.routeKey === operation.key);
      assert.ok(route, operation.key);
      const expected = schemeForAuth[route.auth];
      assert.deepEqual(securitySchemes(specs[operation.spec], operation.operation), expected ? [expected] : [], operation.key);
      assert.equal(operation.operation['x-rate-limit'], route.rateLimit, operation.key);
    }
  });

  it('defines the security schemes the routes use', () => {
    assertMatches(resolve(specs.member, (specs.member.components as Node).securitySchemes), {
      memberBearer: { type: 'http', scheme: 'bearer' },
    });
    assertMatches(resolve(specs.admin, (specs.admin.components as Node).securitySchemes), {
      adminCookie: { type: 'apiKey', in: 'cookie', name: 'agt_admin_session' },
    });
  });

  it('requires the CSRF header on every non-GET admin operation', () => {
    for (const operation of documented.filter((candidate) => candidate.spec === 'admin')) {
      const header = operation.parameters.find((parameter) => parameter.in === 'header' && parameter.name === 'x-agt-request');
      if (operation.method === 'get') assert.equal(header, undefined, operation.key);
      else assert.ok(matches(header, { required: true }), operation.key);
    }
  });

  it('declares every path parameter, and only those', () => {
    for (const operation of documented) {
      const inPath = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((found) => found[1]).sort();
      const declared = operation.parameters.filter((parameter) => parameter.in === 'path');
      assert.deepEqual(declared.map((parameter) => parameter.name).sort(), inPath, operation.key);
      for (const parameter of declared) assert.equal(parameter.required, true, `${operation.key} ${String(parameter.name)}`);
    }
  });

  it('gives every operation an ID, summary, known tag, success response, and error codes on errors', () => {
    const ids = new Set<string>();
    for (const operation of documented) {
      const spec = specs[operation.spec];
      const { operationId, summary, tags, responses } = operation.operation as {
        operationId?: string; summary?: string; tags?: string[]; responses?: Node;
      };
      assert.match(operationId ?? '', /^[a-zA-Z]+$/, operation.key);
      assert.equal(ids.has(operationId!), false, `duplicate ${operationId}`);
      ids.add(operationId!);
      assert.ok(summary, operation.key);
      assert.equal(tags?.length, 1, operation.key);
      assert.ok((spec.tags as Node[]).map((tag) => tag.name).includes(tags![0]), operation.key);
      const statuses = Object.keys(responses ?? {});
      assert.equal(statuses.some((status) => status.startsWith('2')), true, operation.key);
      for (const status of statuses.filter((candidate) => /^[45]/.test(candidate))) {
        const codes = resolve(spec, responses![status])['x-error-codes'];
        assert.equal(Array.isArray(codes) && codes.length > 0, true, `${operation.key} ${status}`);
      }
    }
  });

  it('resolves every $ref', () => {
    for (const spec of Object.values(specs)) {
      for (const ref of collectRefs(spec)) assert.doesNotThrow(() => resolve(spec, { $ref: ref }), ref);
    }
  });

  it('documents only error codes the backend returns', () => {
    const backend = backendErrorCodes();
    assert.ok((backend.size) > 30);
    for (const code of documentedErrorCodes()) assert.equal(backend.has(code), true, code);
  });

  it('lists every backend error code in docs/API.md', () => {
    const guide = read('docs/API.md');
    for (const code of backendErrorCodes()) assert.ok(guide.includes(`\`${code}\``), code);
  });
});
