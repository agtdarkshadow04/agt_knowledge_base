import { ZodError } from 'zod';
import { AppError } from './domain.js';
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
  if (!request.body) throw new AppError('A JSON request body is required.', 400, 'INVALID_REQUEST');
  try {
    return JSON.parse(request.body) as unknown;
  } catch {
    throw new AppError('The request body must contain valid JSON.', 400, 'INVALID_JSON');
  }
}

export function pathId(request: ApiRequest, name: string, label: string, code: string) {
  const id = request.pathParameters[name];
  if (!id || !uuidPattern.test(id)) throw new AppError(`A valid ${label} id is required.`, 400, code);
  return id;
}

/** Maps a thrown error to a response without exposing internal details. */
export function errorResponse(error: unknown, requestId: string): ApiResponse {
  if (error instanceof AppError) return json(error.statusCode, { code: error.code, message: error.message });
  if (error instanceof ZodError) {
    return json(400, {
      code: 'VALIDATION_ERROR',
      message: `The request is invalid: ${error.issues[0].message}`,
      issues: error.issues,
    });
  }
  console.error('Unhandled API error', { requestId, error });
  return json(500, { code: 'INTERNAL_ERROR', message: 'The archive service encountered an unexpected error.' });
}
