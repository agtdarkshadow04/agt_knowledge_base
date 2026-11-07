import { parse } from 'yaml';

/**
 * A small reader for the hand-written OpenAPI 3.1 files in docs/. It turns a
 * spec into a flat model the API reference pages render, resolving local
 * `#/components/...` references. It supports the subset of OpenAPI those
 * files use, plus two extensions: `x-error-codes` on responses and
 * `x-required-role` / `x-rate-limit` on operations.
 */

export type AuthMode = 'none' | 'member' | 'admin';

export interface SchemaField {
  name: string;
  type: string;
  required: boolean;
  constraints: string[];
  description?: string;
}

export interface ApiParameter extends SchemaField {
  location: string;
}

export interface ApiRequestBody {
  contentType: string;
  type: string;
  fields: SchemaField[];
}

export interface ApiResponse {
  status: string;
  description: string;
  errorCodes: string[];
  contentType?: string;
  type?: string;
}

export interface ApiOperation {
  id: string;
  method: string;
  path: string;
  summary: string;
  description?: string;
  auth: AuthMode;
  requiredRole?: string;
  rateLimit?: string;
  csrfHeader: boolean;
  parameters: ApiParameter[];
  requestBody?: ApiRequestBody;
  responses: ApiResponse[];
}

export interface ApiGroup {
  name: string;
  slug: string;
  description?: string;
  operations: ApiOperation[];
}

export interface ApiSchema {
  name: string;
  description?: string;
  type: string;
  fields: SchemaField[];
}

export interface ApiDocument {
  title: string;
  version: string;
  description?: string;
  groups: ApiGroup[];
  schemas: ApiSchema[];
}

type Node = Record<string, unknown>;

export const httpMethods = ['get', 'post', 'put', 'patch', 'delete'] as const;

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function slugify(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
}

function refName(ref: string) {
  return ref.slice(ref.lastIndexOf('/') + 1);
}

function literal(value: unknown) {
  return typeof value === 'string' ? `'${value}'` : String(value);
}

export function parseOpenApi(source: string): ApiDocument {
  const spec: unknown = parse(source);
  if (!isNode(spec) || typeof spec.openapi !== 'string' || !isNode(spec.paths)) {
    throw new Error('The API description is not an OpenAPI document.');
  }
  const root = spec;

  function resolve(value: unknown): Node {
    let current = value;
    for (let depth = 0; isNode(current) && typeof current.$ref === 'string'; depth += 1) {
      const ref = current.$ref;
      if (depth > 10 || !ref.startsWith('#/')) throw new Error(`Unsupported reference ${ref}.`);
      let target: unknown = root;
      for (const part of ref.slice(2).split('/')) target = isNode(target) ? target[part] : undefined;
      if (!isNode(target)) throw new Error(`Unresolved reference ${ref}.`);
      current = target;
    }
    return isNode(current) ? current : {};
  }

  function describeType(schema: unknown): string {
    if (!isNode(schema)) return 'any';
    if (typeof schema.$ref === 'string') return refName(schema.$ref);
    if (Array.isArray(schema.oneOf)) return schema.oneOf.map(describeType).join(' | ');
    if (schema.const !== undefined) return literal(schema.const);
    if (Array.isArray(schema.enum)) return schema.enum.map(literal).join(' | ');
    const types = Array.isArray(schema.type) ? schema.type.map(String) : schema.type ? [String(schema.type)] : [];
    const described = types.map((type) => {
      if (type === 'array') return `${describeType(schema.items)}[]`;
      if (type === 'object' && isNode(schema.additionalProperties)) return `map of ${describeType(schema.additionalProperties)}`;
      if (type === 'string' && typeof schema.contentMediaType === 'string') return `binary (${schema.contentMediaType})`;
      return typeof schema.format === 'string' && type === 'string' ? `string (${schema.format})` : type;
    });
    return described.join(' | ') || 'any';
  }

  function constraints(schema: unknown): string[] {
    if (!isNode(schema) || typeof schema.$ref === 'string') return [];
    const result: string[] = [];
    const number = (value: number) => (Math.abs(value) >= 10_000 ? value.toLocaleString('en-US') : String(value));
    const range = (min: unknown, max: unknown, unit: string) => {
      if (typeof min === 'number' && typeof max === 'number') result.push(`${number(min)}–${number(max)}${unit}`);
      else if (typeof min === 'number') result.push(`at least ${number(min)}${unit}`);
      else if (typeof max === 'number') result.push(`at most ${number(max)}${unit}`);
    };
    range(schema.minLength, schema.maxLength, ' characters');
    range(schema.minimum, schema.maximum, '');
    range(schema.minItems, schema.maxItems, ' items');
    if (schema.uniqueItems === true) result.push('unique items');
    if (typeof schema.pattern === 'string') result.push(`pattern ${schema.pattern}`);
    if (schema.default !== undefined) result.push(`default ${schema.default === '' ? 'empty' : literal(schema.default)}`);
    return result;
  }

  function fields(schema: unknown): SchemaField[] {
    const resolved = resolve(schema);
    if (!isNode(resolved.properties)) return [];
    const required = new Set(list(resolved.required).map(String));
    return Object.entries(resolved.properties).map(([name, property]) => {
      // A property that only references a named schema takes that schema's
      // constraints and description, so shared types such as Password read well.
      const isRef = isNode(property) && typeof property.$ref === 'string';
      const target = isRef ? resolve(property) : property;
      const simpleRef = isRef && isNode(target) && !isNode(target.properties) && !Array.isArray(target.oneOf);
      return {
        name,
        type: describeType(simpleRef ? target : property),
        required: required.has(name),
        constraints: constraints(target),
        description: (isNode(property) ? text(property.description) : undefined) ?? (simpleRef ? text(target.description) : undefined),
      };
    });
  }

  function firstContent(content: unknown) {
    if (!isNode(content)) return undefined;
    const [contentType, media] = Object.entries(content)[0] ?? [];
    return contentType ? { contentType, schema: isNode(media) ? media.schema : undefined } : undefined;
  }

  const schemes = isNode(root.components) && isNode(root.components.securitySchemes) ? root.components.securitySchemes : {};
  function authMode(security: unknown): AuthMode {
    for (const requirement of list(security)) {
      if (!isNode(requirement)) continue;
      for (const name of Object.keys(requirement)) {
        const scheme = resolve(schemes[name]);
        if (scheme.type === 'http' && scheme.scheme === 'bearer') return 'member';
        if (scheme.type === 'apiKey' && scheme.in === 'cookie') return 'admin';
      }
    }
    return 'none';
  }

  const tagOrder = list(root.tags).map(resolve);
  const groups = new Map<string, ApiGroup>(tagOrder.map((tag) => {
    const name = String(tag.name);
    return [name, { name, slug: slugify(name), description: text(tag.description), operations: [] }];
  }));

  for (const [path, rawItem] of Object.entries(root.paths as Node)) {
    const item = resolve(rawItem);
    for (const method of httpMethods) {
      if (!isNode(item[method])) continue;
      const operation = item[method] as Node;
      const parameters = [...list(item.parameters), ...list(operation.parameters)].map((raw) => {
        const parameter = resolve(raw);
        return {
          name: String(parameter.name),
          location: String(parameter.in),
          type: describeType(parameter.schema),
          required: parameter.required === true,
          constraints: constraints(parameter.schema),
          description: text(parameter.description),
        };
      });
      const body = isNode(operation.requestBody) ? firstContent(resolve(operation.requestBody).content) : undefined;
      const responses = Object.entries(isNode(operation.responses) ? operation.responses : {}).map(([status, raw]) => {
        const response = resolve(raw);
        const content = firstContent(response.content);
        return {
          status,
          description: text(response.description) ?? '',
          errorCodes: list(response['x-error-codes']).map(String),
          ...(content ? { contentType: content.contentType, type: describeType(content.schema) } : {}),
        };
      });
      const tag = String(list(operation.tags)[0] ?? 'Other');
      if (!groups.has(tag)) groups.set(tag, { name: tag, slug: slugify(tag), operations: [] });
      groups.get(tag)!.operations.push({
        id: String(operation.operationId ?? slugify(`${method} ${path}`)),
        method: method.toUpperCase(),
        path,
        summary: text(operation.summary) ?? `${method.toUpperCase()} ${path}`,
        description: text(operation.description),
        auth: authMode(operation.security ?? root.security),
        requiredRole: text(operation['x-required-role']),
        rateLimit: text(operation['x-rate-limit']),
        csrfHeader: parameters.some((parameter) => parameter.location === 'header' && parameter.name.toLowerCase() === 'x-agt-request'),
        parameters,
        requestBody: body ? { contentType: body.contentType, type: describeType(body.schema), fields: fields(body.schema) } : undefined,
        responses,
      });
    }
  }

  const componentSchemas = isNode(root.components) && isNode(root.components.schemas) ? root.components.schemas : {};
  const info = resolve(root.info);
  return {
    title: text(info.title) ?? 'API',
    version: text(info.version) ?? '',
    description: text(info.description),
    groups: [...groups.values()].filter((group) => group.operations.length > 0),
    schemas: Object.entries(componentSchemas).map(([name, schema]) => {
      const node = resolve(schema);
      return { name, description: text(node.description), type: describeType(node), fields: fields(node) };
    }),
  };
}
