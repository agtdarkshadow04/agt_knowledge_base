import { describe, it } from 'node:test';
import type { Actor } from '../domain.js';
import { createRequestHandler } from '../handler.js';
import type { ApiRequest } from '../routes.js';
import { assertMatches, respond, testContext } from './helpers.js';

// The test context's database fails the test if a route touches it.
const handleRequest = (request: ApiRequest) => respond(createRequestHandler(testContext()), request);

const editorActor: Actor = { sub: 'editor-sub', role: 'Editor', displayName: 'Editor Traveller' };

function apiRequest(input: Partial<ApiRequest> & Pick<ApiRequest, 'routeKey'>): ApiRequest {
  return { pathParameters: {}, query: {}, actor: null, requestId: 'request-id', ...input };
}

describe('article request validation', () => {
  it('includes the validation reason in the error message', async () => {
    const request = apiRequest({
      routeKey: 'POST /api/articles',
      body: {
        title: 'Portal Guide',
        content: '<script>unsafe</script> content is rejected by the API.',
        tagIds: [],
      },
      requestId: 'request-1',
    });

    const response = await handleRequest(request);

    assertMatches(response, { statusCode: 400 });
    assertMatches(response.body, {
      error: 'validation_failed',
      code: 'VALIDATION_ERROR',
      message: 'The request is invalid: Executable MDX and raw HTML are not allowed.',
    });
  });

  it('requires authentication to view revision history', async () => {
    const request = apiRequest({
      routeKey: 'GET /api/articles/{id}/revisions',
      pathParameters: { id: '00000000-0000-4000-8000-000000000001' },
      requestId: 'request-2',
    });

    const response = await handleRequest(request);

    assertMatches(response, { statusCode: 401 });
  });

  it('rejects revision restoration by Editors before accessing persistence', async () => {
    const request = apiRequest({
      routeKey: 'POST /api/articles/{id}/revisions/{version}/restore',
      pathParameters: { id: '00000000-0000-4000-8000-000000000001', version: '1' },
      body: { currentVersion: 2 },
      requestId: 'request-3',
      actor: editorActor,
    });

    const response = await handleRequest(request);

    assertMatches(response, { statusCode: 403 });
  });

  it('rejects pin changes by Editors before accessing persistence', async () => {
    const request = apiRequest({
      routeKey: 'PATCH /api/articles/{id}/pinning',
      pathParameters: { id: '00000000-0000-4000-8000-000000000001' },
      body: { isPinned: true, version: 1 },
      requestId: 'request-4',
      actor: editorActor,
    });

    const response = await handleRequest(request);

    assertMatches(response, { statusCode: 403 });
  });

  it('rejects verification changes by Editors before accessing persistence', async () => {
    const request = apiRequest({
      routeKey: 'PATCH /api/articles/{id}/verification',
      pathParameters: { id: '00000000-0000-4000-8000-000000000001' },
      body: { isVerified: true, version: 1 },
      requestId: 'request-5',
      actor: editorActor,
    });

    const response = await handleRequest(request);

    assertMatches(response, { statusCode: 403 });
  });

  it('rejects restricted AGT visibility assignments by Editors before accessing persistence', async () => {
    const request = apiRequest({
      routeKey: 'POST /api/articles',
      body: {
        title: 'Restricted Guide',
        content: 'Restricted guidance with enough content for validation.',
        tagIds: [],
        visibility: 2,
      },
      requestId: 'request-6',
      actor: editorActor,
    });

    const response = await handleRequest(request);

    assertMatches(response, { statusCode: 403 });
  });

  it('rejects tag management by Editors before accessing persistence', async () => {
    const request = apiRequest({
      routeKey: 'POST /api/tags',
      body: { name: 'Portal', color: '#B5C3B7' },
      requestId: 'request-7',
      actor: editorActor,
    });

    const response = await handleRequest(request);

    assertMatches(response, { statusCode: 403 });
  });

  it('rejects orphan cleanup by Editors before accessing persistence', async () => {
    const request = apiRequest({
      routeKey: 'DELETE /api/articles/{id}/orphan-tags/{tagId}',
      pathParameters: {
        id: '00000000-0000-4000-8000-000000000001',
        tagId: '10000000-0000-4000-8000-000000000099',
      },
      query: { version: '3' },
      requestId: 'request-8',
      actor: editorActor,
    });

    const response = await handleRequest(request);

    assertMatches(response, { statusCode: 403 });
  });

  it('does not dispatch admin routes, even for Moderators', async () => {
    const moderator: Actor = { sub: 'moderator-sub', role: 'Moderator', displayName: 'Moderator Traveller' };
    for (const routeKey of ['GET /api/admin/stats', 'GET /api/admin/users', 'GET /api/admin/backup', 'POST /api/admin/backup/restore']) {
      const response = await handleRequest(apiRequest({ routeKey, actor: moderator, body: {} }));
      assertMatches(response, { statusCode: 404 });
    }
  });

  it('returns 404 for route keys it does not handle', async () => {
    const response = await handleRequest(apiRequest({ routeKey: 'GET /api/unknown', actor: editorActor }));
    assertMatches(response, { statusCode: 404 });
    assertMatches(response.body, { error: 'not_found', code: 'NOT_FOUND' });
  });
});
