// @vitest-environment node
import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { isAdminPath, matchRoute, routeKeys } from './routes.js';

/**
 * Keeps docs/openapi.yaml (public and member routes) and docs/openapi-admin.yaml
 * (Admin routes) in sync with the route table, and the documented error codes
 * in sync with the codes the backend can return.
 */

type Node = Record<string, unknown>;

const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
const schemeForAuth = { none: undefined, member: 'memberBearer', admin: 'adminCookie' } as const;

function read(relative: string) {
  return readFileSync(new URL(relative, import.meta.url), 'utf8');
}

const specs = {
  member: parse(read('../docs/openapi.yaml')) as Node,
  admin: parse(read('../docs/openapi-admin.yaml')) as Node,
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

/** Error codes the backend can send, found in AppError calls and literal error bodies. */
function backendErrorCodes() {
  const codes = new Set<string>();
  const patterns = [/code: '([A-Z][A-Z_]+)'/g, /\d{3}, '([A-Z][A-Z_]+)'\)/g, /pathId\([^)]*'([A-Z][A-Z_]+)'\)/g];
  for (const file of readdirSync(new URL('.', import.meta.url))) {
    if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
    const source = read(`./${file}`);
    for (const pattern of patterns) for (const match of source.matchAll(pattern)) codes.add(match[1]);
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
      expect(spec.openapi).toBe('3.1.0');
      expect(spec.servers).toEqual([expect.objectContaining({ url: '/api' })]);
    }
  });

  it('documents exactly the routes in routes.ts, once each', () => {
    const keys = documented.map((operation) => operation.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual([...routeKeys].sort());
  });

  it('keeps Admin routes in the admin file and every other route in the member file', () => {
    for (const operation of documented) {
      expect(isAdminPath(operation.path), operation.key).toBe(operation.spec === 'admin');
    }
  });

  it('declares security that matches each route\'s auth mode and rate limit', () => {
    for (const operation of documented) {
      const route = matchRoute(operation.method.toUpperCase(), operation.path);
      expect(route?.routeKey, operation.key).toBe(operation.key);
      const expected = schemeForAuth[route!.auth];
      expect(securitySchemes(specs[operation.spec], operation.operation), operation.key).toEqual(expected ? [expected] : []);
      expect(operation.operation['x-rate-limit'], operation.key).toBe(route!.rateLimit);
    }
  });

  it('defines the security schemes the routes use', () => {
    expect(resolve(specs.member, (specs.member.components as Node).securitySchemes)).toMatchObject({
      memberBearer: { type: 'http', scheme: 'bearer' },
    });
    expect(resolve(specs.admin, (specs.admin.components as Node).securitySchemes)).toMatchObject({
      adminCookie: { type: 'apiKey', in: 'cookie', name: 'agt_admin_session' },
    });
  });

  it('requires the CSRF header on every non-GET admin operation', () => {
    for (const operation of documented.filter((candidate) => candidate.spec === 'admin')) {
      const header = operation.parameters.find((parameter) => parameter.in === 'header' && parameter.name === 'x-agt-request');
      if (operation.method === 'get') expect(header, operation.key).toBeUndefined();
      else expect(header, operation.key).toMatchObject({ required: true });
    }
  });

  it('declares every path parameter, and only those', () => {
    for (const operation of documented) {
      const inPath = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]).sort();
      const declared = operation.parameters.filter((parameter) => parameter.in === 'path');
      expect(declared.map((parameter) => parameter.name).sort(), operation.key).toEqual(inPath);
      for (const parameter of declared) expect(parameter.required, `${operation.key} ${String(parameter.name)}`).toBe(true);
    }
  });

  it('gives every operation an ID, summary, known tag, success response, and error codes on errors', () => {
    const ids = new Set<string>();
    for (const operation of documented) {
      const spec = specs[operation.spec];
      const { operationId, summary, tags, responses } = operation.operation as {
        operationId?: string; summary?: string; tags?: string[]; responses?: Node;
      };
      expect(operationId, operation.key).toMatch(/^[a-zA-Z]+$/);
      expect(ids.has(operationId!), `duplicate ${operationId}`).toBe(false);
      ids.add(operationId!);
      expect(summary, operation.key).toBeTruthy();
      expect(tags?.length, operation.key).toBe(1);
      expect((spec.tags as Node[]).map((tag) => tag.name), operation.key).toContain(tags![0]);
      const statuses = Object.keys(responses ?? {});
      expect(statuses.some((status) => status.startsWith('2')), operation.key).toBe(true);
      for (const status of statuses.filter((candidate) => /^[45]/.test(candidate))) {
        const codes = resolve(spec, responses![status])['x-error-codes'];
        expect(Array.isArray(codes) && codes.length > 0, `${operation.key} ${status}`).toBe(true);
      }
    }
  });

  it('resolves every $ref', () => {
    for (const spec of Object.values(specs)) {
      for (const ref of collectRefs(spec)) expect(() => resolve(spec, { $ref: ref }), ref).not.toThrow();
    }
  });

  it('documents only error codes the backend returns', () => {
    const backend = backendErrorCodes();
    expect(backend.size).toBeGreaterThan(30);
    for (const code of documentedErrorCodes()) expect(backend.has(code), code).toBe(true);
  });

  it('lists every backend error code in docs/API.md', () => {
    const guide = read('../docs/API.md');
    for (const code of backendErrorCodes()) expect(guide, code).toContain(`\`${code}\``);
  });
});
