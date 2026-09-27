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
});
