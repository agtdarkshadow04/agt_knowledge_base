import { ZodError } from 'zod';
import { fieldError, fieldErrorsFromIssues, type FieldCode, type FieldError } from '../src/lib/errors.js';

export type ErrorParams = Record<string, string | number | boolean>;

export interface HttpErrorOptions {
  /** Field-level errors (`validation_failed` and conflicts on one field). */
  fields?: FieldError[];
  /** Values the translated message needs, e.g. `{ retryAfterSeconds }` (API-6). */
  params?: ErrorParams;
  /**
   * The 1.x UPPER_SNAKE_CASE code, still sent as the deprecated `code` property
   * until 3.0.0 (VER-10). Defaults to `error` in upper case.
   */
  legacyCode?: string;
}

/**
 * An error with an HTTP status and a stable snake_case code (SRV-5, API-6).
 * Throw it from services and routes; the app's single error handler turns it
 * into the error body.
 */
export class HttpError extends Error {
  readonly fields?: FieldError[];
  readonly params?: ErrorParams;
  readonly legacyCode: string;

  constructor(readonly statusCode: number, readonly error: string, message: string, options: HttpErrorOptions = {}) {
    super(message);
    this.name = 'HttpError';
    this.fields = options.fields;
    this.params = options.params;
    this.legacyCode = options.legacyCode ?? error.toUpperCase();
  }
}

/** A `400 validation_failed` for one field. */
export function invalidField(field: string, code: FieldCode, message: string, legacyCode = 'VALIDATION_ERROR') {
  return new HttpError(400, 'validation_failed', message, { fields: [fieldError(field, code, message)], legacyCode });
}

export interface ErrorReply {
  statusCode: number;
  headers: Record<string, string>;
  body: ErrorBody;
}

/**
 * The error body (API-6). `code` and `issues` are the deprecated 1.x
 * properties, kept until 3.0.0 (VER-10).
 */
export interface ErrorBody {
  error: string;
  message: string;
  params?: ErrorParams;
  fields?: FieldError[];
  code: string;
  issues?: unknown[];
}

/** Fastify's own errors carry a `code` such as FST_ERR_CTP_BODY_TOO_LARGE and a status. */
function fastifyError(error: unknown): { code: string; statusCode?: number } | null {
  if (!(error instanceof Error) || !('code' in error) || typeof error.code !== 'string') return null;
  if (!error.code.startsWith('FST_')) return null;
  const statusCode = 'statusCode' in error && typeof error.statusCode === 'number' ? error.statusCode : undefined;
  return { code: error.code, statusCode };
}

/** An Ajv error from a route's TypeBox schema, as Fastify attaches it to `error.validation`. */
interface SchemaIssue {
  keyword: string;
  instancePath: string;
  message?: string;
  params: Record<string, unknown>;
}

function schemaIssues(error: unknown): SchemaIssue[] | null {
  if (!(error instanceof Error) || !('validation' in error) || !Array.isArray(error.validation)) return null;
  return error.validation as SchemaIssue[];
}

/** Maps a schema failure to field errors; the field is the request property, dotted. */
export function fieldErrorsFromSchema(issues: SchemaIssue[]): FieldError[] {
  return issues.map((issue) => {
    const path = issue.instancePath.split('/').filter(Boolean);
    const name = (extra?: unknown) => [...path, ...(typeof extra === 'string' ? [extra] : [])].join('.');
    const limit = typeof issue.params.limit === 'number' ? issue.params.limit : undefined;
    switch (issue.keyword) {
      case 'required':
        return fieldError(name(issue.params.missingProperty), 'required', `${name(issue.params.missingProperty)} is required.`);
      case 'additionalProperties':
        return fieldError(name(issue.params.additionalProperty), 'not_allowed', `${name(issue.params.additionalProperty)} is not allowed.`);
      case 'maxLength':
        return fieldError(name(), 'too_long', `${name()} must be at most ${limit} characters.`, limit === undefined ? undefined : { max: limit });
      case 'minLength':
        return limit === 1
          ? fieldError(name(), 'required', `${name()} is required.`)
          : fieldError(name(), 'too_short', `${name()} must be at least ${limit} characters.`, limit === undefined ? undefined : { min: limit });
      case 'maxItems':
        return fieldError(name(), 'too_many', `${name()} must have at most ${limit} items.`, limit === undefined ? undefined : { max: limit });
      case 'maximum':
      case 'exclusiveMaximum':
        return fieldError(name(), 'out_of_range', `${name()} is too large.`, limit === undefined ? undefined : { max: limit });
      case 'minimum':
      case 'exclusiveMinimum':
        return fieldError(name(), 'out_of_range', `${name()} is too small.`, limit === undefined ? undefined : { min: limit });
      case 'enum':
      case 'const':
      case 'anyOf':
      case 'oneOf':
        return fieldError(name(), 'not_allowed', `${name()} is not an allowed value.`);
      case 'format':
        return fieldError(name(), issue.params.format === 'uri' ? 'invalid_url' : 'invalid_format', `${name()} has the wrong format.`);
      default:
        return fieldError(name(), 'invalid_format', `${name()} has the wrong type or format.`);
    }
  });
}

function body(error: string, message: string, legacyCode: string, extra: Partial<ErrorBody> = {}): ErrorBody {
  return { error, message, ...extra, code: legacyCode };
}

/**
 * Maps any thrown error to a response without exposing internal details. This
 * is the only place that decides an error body; unexpected errors are reported
 * through `onUnexpected` and answered with a generic 500.
 */
export function errorReply(error: unknown, onUnexpected: (error: unknown) => void = () => undefined): ErrorReply {
  const reply = (statusCode: number, errorBody: ErrorBody, headers: Record<string, string> = {}): ErrorReply => ({
    statusCode,
    headers,
    body: errorBody,
  });
  if (error instanceof HttpError) {
    const headers: Record<string, string> = {};
    if (error.params && typeof error.params.retryAfterSeconds === 'number') headers['retry-after'] = String(error.params.retryAfterSeconds);
    if (error instanceof BodyTooLargeError) headers.connection = 'close';
    return reply(error.statusCode, body(error.error, error.message, error.legacyCode, {
      ...(error.params ? { params: error.params } : {}),
      ...(error.fields ? { fields: error.fields } : {}),
    }), headers);
  }
  if (error instanceof ZodError) {
    return reply(400, body('validation_failed', `The request is invalid: ${error.issues[0].message}`, 'VALIDATION_ERROR', {
      fields: fieldErrorsFromIssues(error.issues),
      issues: error.issues,
    }));
  }
  const issues = schemaIssues(error);
  if (issues) {
    const fields = fieldErrorsFromSchema(issues);
    return reply(400, body('validation_failed', `The request is invalid: ${fields[0]?.message ?? 'it does not match the schema.'}`, 'VALIDATION_ERROR', { fields }));
  }
  const fastify = fastifyError(error);
  if (fastify?.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return reply(413, body('body_too_large', 'Request body is too large.', 'BODY_TOO_LARGE'), { connection: 'close' });
  }
  if (fastify && fastify.statusCode && fastify.statusCode >= 400 && fastify.statusCode < 500) {
    return reply(400, body('invalid_request', 'The request is invalid.', 'INVALID_REQUEST'));
  }
  onUnexpected(error);
  return reply(500, body('internal', 'An unexpected server error occurred.', 'INTERNAL_ERROR'));
}

/** A rate limit was hit; answered with `429`, `Retry-After` and `params.retryAfterSeconds`. */
export class RateLimitedError extends HttpError {
  constructor(readonly retryAfterSeconds: number) {
    super(429, 'rate_limited', `Too many requests. Try again in ${retryAfterSeconds} seconds.`, {
      params: { retryAfterSeconds },
      legacyCode: 'RATE_LIMITED',
    });
  }
}

/** A request body exceeded its route's limit. */
export class BodyTooLargeError extends HttpError {
  constructor(maxBytes: number) {
    super(413, 'file_too_large', 'Request body is too large.', { params: { maxBytes }, legacyCode: 'BODY_TOO_LARGE' });
  }
}
