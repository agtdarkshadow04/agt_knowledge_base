// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { Actor } from './domain.js';
import { handleRequest } from './handler.js';
import type { ApiRequest } from './routes.js';

const standardActor: Actor = { sub: 'standard-sub', role: 'Standard', displayName: 'Standard Traveller' };

function apiRequest(input: Partial<ApiRequest> & Pick<ApiRequest, 'routeKey'>): ApiRequest {
  return { pathParameters: {}, query: {}, actor: null, requestId: 'request-id', ...input };
}

describe('article request validation', () => {
  it('includes the validation reason in the error message', async () => {
    const request = apiRequest({
      routeKey: 'POST /articles',
      body: JSON.stringify({
        title: 'Portal Guide',
        content: '<script>unsafe</script> content is rejected by the API.',
        tagIds: [],
      }),
      requestId: 'request-1',
    });

    const response = await handleRequest(request);

    expect(response).toMatchObject({ statusCode: 400 });
    expect(JSON.parse(response.body ?? '')).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'The request is invalid: Executable MDX and raw HTML are not allowed.',
    });
  });

  it('requires authentication to view revision history', async () => {
    const request = apiRequest({
      routeKey: 'GET /articles/{id}/revisions',
      pathParameters: { id: '00000000-0000-4000-8000-000000000001' },
      requestId: 'request-2',
    });

    const response = await handleRequest(request);

    expect(response).toMatchObject({ statusCode: 401 });
  });

  it('rejects revision restoration by Standard users before accessing persistence', async () => {
    const request = apiRequest({
      routeKey: 'POST /articles/{id}/revisions/{version}/restore',
      pathParameters: { id: '00000000-0000-4000-8000-000000000001', version: '1' },
      body: JSON.stringify({ currentVersion: 2 }),
      requestId: 'request-3',
      actor: standardActor,
    });

    const response = await handleRequest(request);

    expect(response).toMatchObject({ statusCode: 403 });
  });

  it('rejects pin changes by Standard users before accessing persistence', async () => {
    const request = apiRequest({
      routeKey: 'PATCH /articles/{id}/pinning',
      pathParameters: { id: '00000000-0000-4000-8000-000000000001' },
      body: JSON.stringify({ isPinned: true, version: 1 }),
      requestId: 'request-4',
      actor: standardActor,
    });

    const response = await handleRequest(request);

    expect(response).toMatchObject({ statusCode: 403 });
  });

  it('rejects verification changes by Standard users before accessing persistence', async () => {
    const request = apiRequest({
      routeKey: 'PATCH /articles/{id}/verification',
      pathParameters: { id: '00000000-0000-4000-8000-000000000001' },
      body: JSON.stringify({ isVerified: true, version: 1 }),
      requestId: 'request-5',
      actor: standardActor,
    });

    const response = await handleRequest(request);

    expect(response).toMatchObject({ statusCode: 403 });
  });

  it('rejects restricted AGT visibility assignments by Standard users before accessing persistence', async () => {
    const request = apiRequest({
      routeKey: 'POST /articles',
      body: JSON.stringify({
        title: 'Restricted Guide',
        content: 'Restricted guidance with enough content for validation.',
        tagIds: [],
        visibility: 2,
      }),
      requestId: 'request-6',
      actor: standardActor,
    });

    const response = await handleRequest(request);

    expect(response).toMatchObject({ statusCode: 403 });
  });

  it('rejects tag management by Standard users before accessing persistence', async () => {
    const request = apiRequest({
      routeKey: 'POST /tags',
      body: JSON.stringify({ name: 'Portal', color: '#B5C3B7' }),
      requestId: 'request-7',
      actor: standardActor,
    });

    const response = await handleRequest(request);

    expect(response).toMatchObject({ statusCode: 403 });
  });

  it('rejects orphan cleanup by Standard users before accessing persistence', async () => {
    const request = apiRequest({
      routeKey: 'DELETE /articles/{id}/orphan-tags/{tagId}',
      pathParameters: {
        id: '00000000-0000-4000-8000-000000000001',
        tagId: '10000000-0000-4000-8000-000000000099',
      },
      query: { version: '3' },
      requestId: 'request-8',
      actor: standardActor,
    });

    const response = await handleRequest(request);

    expect(response).toMatchObject({ statusCode: 403 });
  });

  it('rejects Standard users from admin routes before accessing persistence', async () => {
    const request = apiRequest({
      routeKey: 'GET /admin/stats',
      requestId: 'request-9',
      actor: standardActor,
    });

    const response = await handleRequest(request);

    expect(response).toMatchObject({ statusCode: 403 });
    expect(JSON.parse(response.body ?? '')).toMatchObject({ code: 'FORBIDDEN' });
  });

  it('rejects backup export and restore by Standard users and ordinary administrators', async () => {
    const admin: Actor = { sub: 'admin-sub', role: 'Admin', displayName: 'Admin Traveller', isSuperAdmin: false };
    for (const actor of [standardActor, admin]) {
      for (const routeKey of ['GET /admin/backup', 'POST /admin/backup/restore']) {
        const response = await handleRequest(apiRequest({ routeKey, actor, body: '{}' }));
        expect(response).toMatchObject({ statusCode: 403 });
        expect(JSON.parse(response.body ?? '')).toMatchObject({ code: 'FORBIDDEN' });
      }
    }
  });

  it('validates the backup format before accessing persistence', async () => {
    const superAdmin: Actor = { sub: 'super-sub', role: 'Admin', displayName: 'Super Traveller', isSuperAdmin: true };
    const response = await handleRequest(apiRequest({
      routeKey: 'POST /admin/backup/restore',
      actor: superAdmin,
      body: JSON.stringify({ format: 'something-else', formatVersion: 1, createdAt: '', migrations: [], tables: {} }),
    }));
    expect(response).toMatchObject({ statusCode: 400 });
    expect(JSON.parse(response.body ?? '')).toMatchObject({ code: 'VALIDATION_ERROR' });
  });

  it('returns 404 for route keys it does not handle', async () => {
    const response = await handleRequest(apiRequest({ routeKey: 'GET /unknown', actor: standardActor }));
    expect(response).toMatchObject({ statusCode: 404 });
    expect(JSON.parse(response.body ?? '')).toMatchObject({ code: 'NOT_FOUND' });
  });
});
