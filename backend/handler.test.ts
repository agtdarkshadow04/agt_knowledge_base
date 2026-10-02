// @vitest-environment node
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it } from 'vitest';
import { handler } from './handler.js';

describe('article request validation', () => {
  it('includes the validation reason in the error message', async () => {
    const event = {
      routeKey: 'POST /articles',
      body: JSON.stringify({
        title: 'Portal Guide',
        content: '<script>unsafe</script> content is rejected by the API.',
        tags: [],
      }),
      requestContext: { requestId: 'request-1' },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

    const response = await handler(event);

    if (typeof response === 'string') throw new Error('Expected a structured API response.');
    expect(response).toMatchObject({ statusCode: 400 });
    expect(JSON.parse(response.body ?? '')).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'The request is invalid: Executable MDX and raw HTML are not allowed.',
    });
  });

  it('requires authentication to view revision history', async () => {
    const event = {
      routeKey: 'GET /articles/{id}/revisions',
      pathParameters: { id: '00000000-0000-4000-8000-000000000001' },
      requestContext: { requestId: 'request-2', authorizer: { jwt: { claims: {} } } },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

    const response = await handler(event);

    if (typeof response === 'string') throw new Error('Expected a structured API response.');
    expect(response).toMatchObject({ statusCode: 401 });
  });

  it('rejects revision restoration by Standard users before accessing persistence', async () => {
    const event = {
      routeKey: 'POST /articles/{id}/revisions/{version}/restore',
      pathParameters: { id: '00000000-0000-4000-8000-000000000001', version: '1' },
      body: JSON.stringify({ currentVersion: 2 }),
      requestContext: {
        requestId: 'request-3',
        authorizer: { jwt: { claims: { sub: 'standard-sub', 'cognito:groups': ['Standard'] } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

    const response = await handler(event);

    if (typeof response === 'string') throw new Error('Expected a structured API response.');
    expect(response).toMatchObject({ statusCode: 403 });
  });

  it('rejects pin changes by Standard users before accessing persistence', async () => {
    const event = {
      routeKey: 'PATCH /articles/{id}/pinning',
      pathParameters: { id: '00000000-0000-4000-8000-000000000001' },
      body: JSON.stringify({ isPinned: true, version: 1 }),
      requestContext: {
        requestId: 'request-4',
        authorizer: { jwt: { claims: { sub: 'standard-sub', 'cognito:groups': ['Standard'] } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

    const response = await handler(event);

    if (typeof response === 'string') throw new Error('Expected a structured API response.');
    expect(response).toMatchObject({ statusCode: 403 });
  });

  it('rejects Admin visibility assignments by Standard users before accessing persistence', async () => {
    const event = {
      routeKey: 'POST /articles',
      body: JSON.stringify({
        title: 'Restricted Guide',
        content: 'Restricted guidance with enough content for validation.',
        tags: [],
        visibility: 'Admin',
      }),
      requestContext: {
        requestId: 'request-5',
        authorizer: { jwt: { claims: { sub: 'standard-sub', 'cognito:groups': ['Standard'] } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

    const response = await handler(event);

    if (typeof response === 'string') throw new Error('Expected a structured API response.');
    expect(response).toMatchObject({ statusCode: 403 });
  });
});
