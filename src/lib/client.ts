import type { FieldError } from './errors.js';

/**
 * The one way the browser calls the API (FE-2): same-origin, `cache: 'no-store'`,
 * `credentials: 'same-origin'`, JSON in and out, the CSRF header on every
 * non-GET request (SEC-5) and `x-agt-client: web` on every request (LOG-13).
 * A failed request throws an `ApiError` built from the API-6 error body.
 *
 * `503 maintenance` (BAK-8) is reported to the maintenance listeners, so the UI
 * can show a non-blocking notice, and retried once after `Retry-After` (FE-5).
 */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The API-6 `error` code; `network_error` when no response arrived. */
    readonly code: string,
    readonly fields: FieldError[] = [],
    readonly params: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }

  /** The field error for `field`, if the server reported one. */
  field(field: string) {
    return this.fields.find((error) => error.field === field);
  }
}

export interface RequestOptions {
  method?: string;
  /** A JSON value, or `FormData` for multipart uploads. */
  body?: unknown;
  signal?: AbortSignal;
  /** The `Accept` header; `application/json` by default. */
  accept?: string;
}

/** The base path of every API route; requests are always same-origin. */
export const apiBase = '/api';

/** The longest `Retry-After` a client waits before its one retry, in seconds. */
export const maxRetryAfterSeconds = 60;

export type MaintenanceListener = (retryAfterSeconds: number) => void;

const maintenanceListeners = new Set<MaintenanceListener>();

/** Calls `listener` whenever a request is answered `503 maintenance`; returns the unsubscribe function. */
export function onMaintenance(listener: MaintenanceListener) {
  maintenanceListeners.add(listener);
  return () => { maintenanceListeners.delete(listener); };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFieldError(value: unknown): value is FieldError {
  return isRecord(value) && typeof value.field === 'string' && typeof value.code === 'string' && typeof value.message === 'string';
}

/** Builds the `ApiError` for a failed response from its body, read defensively. */
export function apiErrorFrom(status: number, payload: unknown): ApiError {
  const body = isRecord(payload) ? payload : {};
  const code = typeof body.error === 'string' ? body.error : 'internal';
  const message = typeof body.message === 'string' ? body.message : `Request failed with status ${status}`;
  const fields = Array.isArray(body.fields) ? body.fields.filter(isFieldError) : [];
  return new ApiError(status, message, code, fields, isRecord(body.params) ? body.params : {});
}

/** The `Retry-After` of a response in whole seconds (1 to `maxRetryAfterSeconds`; 10 when absent or invalid). */
export function retryAfterSeconds(header: string | null) {
  const seconds = Number(header);
  if (!header || !Number.isFinite(seconds) || seconds < 0) return 10;
  return Math.min(Math.max(Math.ceil(seconds), 1), maxRetryAfterSeconds);
}

function wait(seconds: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, seconds * 1000);
    function abort() { clearTimeout(timer); reject(signal!.reason); }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function url(path: string) {
  return path.startsWith(`${apiBase}/`) ? path : `${apiBase}${path}`;
}

async function send(path: string, options: RequestOptions) {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers({ Accept: options.accept ?? 'application/json', 'x-agt-client': 'web' });
  if (method !== 'GET' && method !== 'HEAD') headers.set('x-agt-request', '1');
  let body: FormData | string | undefined;
  if (options.body instanceof FormData) body = options.body;
  else if (options.body !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(options.body);
  }
  try {
    return await fetch(url(path), { method, headers, body, signal: options.signal, cache: 'no-store', credentials: 'same-origin' });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError(0, 'The server could not be reached. Check the connection and try again.', 'network_error');
  }
}

/**
 * Sends a request and returns the successful `Response`, for downloads that read
 * the body as a blob. Paths are relative to `/api` (`/articles`), or start with it.
 */
export async function apiFetch(path: string, options: RequestOptions = {}): Promise<Response> {
  let response = await send(path, options);
  for (let retried = false; !response.ok; retried = true) {
    const payload = await response.json().catch(() => undefined);
    const error = apiErrorFrom(response.status, payload);
    if (response.status !== 503 || error.code !== 'maintenance' || retried) throw error;
    const seconds = retryAfterSeconds(response.headers.get('retry-after'));
    for (const listener of maintenanceListeners) listener(seconds);
    await wait(seconds, options.signal);
    response = await send(path, options);
  }
  return response;
}

/** Sends a request and returns its JSON body (`undefined` for `204`). */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const response = await apiFetch(path, options);
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** The file name in a `Content-Disposition` header, or `fallback`. */
export function attachmentName(response: Response, fallback: string) {
  const disposition = response.headers.get('content-disposition') ?? '';
  return /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallback;
}
