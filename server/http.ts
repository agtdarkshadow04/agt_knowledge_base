import { ZodError } from 'zod';

/**
 * An error with an HTTP status and a stable code (SRV-5). Throw it from
 * services and routes; the app's single error handler turns it into the
 * error body.
 */
export class HttpError extends Error {
  constructor(readonly statusCode: number, readonly code: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface ErrorReply {
  statusCode: number;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

/** Fastify's own errors carry a `code` such as FST_ERR_CTP_BODY_TOO_LARGE and a status. */
function fastifyError(error: unknown): { code: string; statusCode?: number } | null {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return null;
  if (!error.code.startsWith('FST_')) return null;
  const statusCode = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined;
  return { code: error.code, statusCode };
}

/**
 * Maps any thrown error to a response without exposing internal details. This
 * is the only place that decides an error body; unexpected errors are reported
 * through `onUnexpected` and answered with a generic 500.
 */
export function errorReply(error: unknown, onUnexpected: (error: unknown) => void = () => undefined): ErrorReply {
  const reply = (statusCode: number, body: Record<string, unknown>, headers: Record<string, string> = {}): ErrorReply => ({
    statusCode,
    headers,
    body,
  });
  if (error instanceof HttpError) {
    const headers: Record<string, string> = {};
    if (error instanceof RateLimitedError) headers['retry-after'] = String(error.retryAfterSeconds);
    if (error instanceof BodyTooLargeError) headers.connection = 'close';
    return reply(error.statusCode, { code: error.code, message: error.message }, headers);
  }
  if (error instanceof ZodError) {
    return reply(400, {
      code: 'VALIDATION_ERROR',
      message: `The request is invalid: ${error.issues[0].message}`,
      issues: error.issues,
    });
  }
  const fastify = fastifyError(error);
  if (fastify?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return reply(413, { code: 'BODY_TOO_LARGE', message: 'Request body is too large.' }, { connection: 'close' });
  }
  if (fastify && fastify.statusCode && fastify.statusCode >= 400 && fastify.statusCode < 500) {
    return reply(400, { code: 'INVALID_REQUEST', message: 'The request is invalid.' });
  }
  onUnexpected(error);
  return reply(500, { code: 'INTERNAL_ERROR', message: 'The archive service encountered an unexpected error.' });
}

/** A rate limit was hit; answered with `429` and `Retry-After`. */
export class RateLimitedError extends HttpError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, 'RATE_LIMITED', 'Too many attempts. Try again later.');
  }
}

/** A request body exceeded its route's limit. */
export class BodyTooLargeError extends HttpError {
  constructor() {
    super(413, 'BODY_TOO_LARGE', 'Request body is too large.');
  }
}
