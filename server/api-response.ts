import { HttpError } from './http.js';
import type { ApiRequest, ApiResponse } from './routes.js';

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function json(statusCode: number, body: unknown, publiclyCacheable = false): ApiResponse {
  return {
    statusCode,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': statusCode === 200 && publiclyCacheable ? 'public, max-age=30' : 'no-store',
      'x-content-type-options': 'nosniff',
    },
    body,
  };
}

export function noContent(): ApiResponse {
  return { statusCode: 204, headers: { 'cache-control': 'no-store' } };
}

/** The parsed JSON body; Fastify has already parsed it and checked it against the route schema. */
export function parseBody(request: Pick<ApiRequest, 'body'>) {
  if (request.body === undefined || request.body === null) {
    throw new HttpError(400, 'invalid_request', 'A JSON request body is required.');
  }
  return request.body;
}

export function pathId(request: ApiRequest, name: string, label: string, legacyCode: string) {
  const id = request.pathParameters[name];
  // A malformed ID names no resource: 404, like an unknown one (API-5).
  if (!id || !uuidPattern.test(id)) throw new HttpError(404, 'not_found', `No ${label} has the id ${JSON.stringify(id ?? '')}.`, { legacyCode });
  return id;
}
