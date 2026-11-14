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
    body: JSON.stringify(body),
  };
}

export function noContent(): ApiResponse {
  return { statusCode: 204, headers: { 'cache-control': 'no-store' } };
}

export function parseBody(request: Pick<ApiRequest, 'body'>) {
  if (!request.body) throw new HttpError(400, 'INVALID_REQUEST', 'A JSON request body is required.');
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw new HttpError(400, 'INVALID_JSON', 'The request body must contain valid JSON.');
  }
}

export function pathId(request: ApiRequest, name: string, label: string, code: string) {
  const id = request.pathParameters[name];
  if (!id || !uuidPattern.test(id)) throw new HttpError(400, code, `A valid ${label} id is required.`);
  return id;
}
