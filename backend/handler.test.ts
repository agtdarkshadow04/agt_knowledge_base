// @vitest-environment node
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handler } from './handler.js';

const mocks = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  AdminGetUserCommand: class {
    constructor(readonly input: unknown) {}
  },
  CognitoIdentityProviderClient: class {
    send = mocks.send;
  },
}));

beforeEach(() => {
  mocks.send.mockReset();
  process.env.COGNITO_USER_POOL_ID = 'pool-1';
});

describe('account details', () => {
  it('returns the Cognito creation date without public caching', async () => {
    mocks.send.mockResolvedValue({ UserCreateDate: new Date('2024-03-12T10:15:00.000Z') });
    const event = {
      routeKey: 'GET /account',
      requestContext: {
        requestId: 'request-1',
        authorizer: { jwt: { claims: { 'cognito:username': 'traveller' } } },
      },
    } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

    const response = await handler(event);

    if (typeof response === 'string') throw new Error('Expected a structured API response.');
    expect(response).toMatchObject({ statusCode: 200, headers: { 'cache-control': 'no-store' } });
    expect(JSON.parse(response.body ?? '')).toEqual({ createdAt: '2024-03-12T10:15:00.000Z' });
    expect(mocks.send).toHaveBeenCalledOnce();
  });
});

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
