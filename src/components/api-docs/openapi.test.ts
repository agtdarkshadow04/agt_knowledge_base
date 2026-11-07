import { describe, expect, it } from 'vitest';
import adminSpec from '../../../docs/openapi-admin.yaml?raw';
import memberSpec from '../../../docs/openapi.yaml?raw';
import { parseOpenApi } from './openapi';

const member = parseOpenApi(memberSpec);
const admin = parseOpenApi(adminSpec);

function operation(document: typeof member, method: string, path: string) {
  const found = document.groups.flatMap((group) => group.operations).find((candidate) => candidate.method === method && candidate.path === path);
  if (!found) throw new Error(`${method} ${path} is not documented`);
  return found;
}

describe('parseOpenApi', () => {
  it('groups operations by tag in the declared order', () => {
    expect(member.title).toBe('AGT Knowledge Base API');
    expect(member.groups.map((group) => group.name)).toEqual(['Auth & settings', 'Articles', 'Tags', 'Member reads']);
    expect(admin.groups.map((group) => group.name)).toEqual(['Admin setup & session', 'Members', 'Data & settings', 'Backups']);
  });

  it('derives auth, role, and rate limits from security and extensions', () => {
    expect(operation(member, 'GET', '/articles')).toMatchObject({ auth: 'none', csrfHeader: false });
    expect(operation(member, 'POST', '/auth/login')).toMatchObject({ auth: 'none', rateLimit: 'login' });
    expect(operation(member, 'DELETE', '/articles/{id}')).toMatchObject({ auth: 'member', requiredRole: 'Moderator' });
    expect(operation(member, 'PUT', '/articles/{id}').requiredRole).toBeUndefined();
    expect(operation(admin, 'PUT', '/admin/settings')).toMatchObject({ auth: 'admin', csrfHeader: true });
    expect(operation(admin, 'POST', '/admin/setup')).toMatchObject({ auth: 'none', csrfHeader: true, rateLimit: 'setup' });
    expect(operation(admin, 'GET', '/admin/stats').csrfHeader).toBe(false);
  });

  it('merges path-level parameters and resolves shared ones with their constraints', () => {
    const remove = operation(member, 'DELETE', '/articles/{id}/orphan-tags/{tagId}');
    expect(remove.parameters.map((parameter) => `${parameter.location}:${parameter.name}`)).toEqual(['path:id', 'path:tagId', 'query:version']);
    const pageSize = operation(member, 'GET', '/articles').parameters.find((parameter) => parameter.name === 'pageSize');
    expect(pageSize).toMatchObject({ type: 'integer', required: false, constraints: ['1–50', 'default 12'] });
  });

  it('flattens request bodies into fields with validation constraints', () => {
    const body = operation(member, 'POST', '/articles').requestBody!;
    expect(body).toMatchObject({ contentType: 'application/json', type: 'ArticleInput' });
    expect(body.fields.find((field) => field.name === 'title')).toMatchObject({ type: 'string', required: true, constraints: ['3–180 characters'] });
    expect(body.fields.find((field) => field.name === 'tagIds')).toMatchObject({ type: 'string (uuid)[]', constraints: ['at most 12 items', 'unique items'] });
    expect(body.fields.find((field) => field.name === 'visibility')).toMatchObject({ type: 'Visibility', required: false });
    const password = operation(admin, 'POST', '/admin/users').requestBody!.fields.find((field) => field.name === 'password');
    expect(password).toMatchObject({ type: 'string', constraints: ['12–1024 characters'] });
    expect(password?.description).toContain('symbol');
  });

  it('collects responses with error codes from shared responses', () => {
    const responses = operation(member, 'PUT', '/articles/{id}').responses;
    expect(responses.find((response) => response.status === '200')).toMatchObject({ type: 'Article' });
    expect(responses.find((response) => response.status === '401')?.errorCodes).toEqual(['UNAUTHENTICATED']);
    expect(responses.find((response) => response.status === '409')?.errorCodes).toEqual(['VERSION_CONFLICT']);
    expect(operation(member, 'GET', '/tags').responses.find((response) => response.status === '200')?.type).toBe('Tag[]');
  });

  it('lists component schemas', () => {
    expect(member.schemas.find((schema) => schema.name === 'Visibility')?.type).toBe("'Public' | 'Internal' | 'Admin' | 0 | 1 | 2 | 3 | 4 | 5");
    expect(admin.schemas.find((schema) => schema.name === 'SettingsWrite')?.fields.find((field) => field.name === 'backupMaxBytes')?.type).toBe('integer | null');
  });

  it('rejects documents that are not OpenAPI', () => {
    expect(() => parseOpenApi('hello: world')).toThrow('not an OpenAPI document');
    expect(() => parseOpenApi("openapi: 3.1.0\npaths:\n  /x:\n    get:\n      parameters:\n        - $ref: '#/components/parameters/Missing'\n")).toThrow('Unresolved reference');
  });
});
