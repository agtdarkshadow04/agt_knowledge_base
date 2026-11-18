import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { SettingValues } from './config.js';
import type { AppContext } from './context.js';
import { isSecurityLevel, type Role, type SecurityLevel } from './domain.js';
import { HttpError, RateLimitedError } from './http.js';

/**
 * AGT IAM sign-in for members (issue #30). `IamClient` is the only code that
 * makes an outbound request, and only to `iam.baseUrl` while `iam.enabled` is
 * on: a deviation from SEC-14 recorded in AGENTS.md. It sends the traveller's
 * name and password once, never stores them, and never retries.
 */

/** What AGT IAM sign-in needs and is missing. */
export type IamMissing = 'baseUrl' | 'appId' | 'apiKey';

export interface IamStatus {
  /** The effective `iam.enabled` setting. */
  enabled: boolean;
  /** Enabled and fully configured: members can sign in with their AGT account. */
  available: boolean;
  /** What is not configured, whether or not the setting is on. */
  missing: IamMissing[];
}

/** Whether AGT IAM sign-in is on and configured. */
export function iamStatus(context: Pick<AppContext, 'config' | 'iamApiKey'>, values: Pick<SettingValues, 'iam.enabled'>): IamStatus {
  const { iam } = context.config;
  const missing: IamMissing[] = [];
  if (!iam.baseUrl) missing.push('baseUrl');
  if (!iam.appId) missing.push('appId');
  if (!context.iamApiKey) missing.push('apiKey');
  const enabled = values['iam.enabled'];
  return { enabled, available: enabled && missing.length === 0, missing };
}

/** Where the operator sets a missing item. */
export function iamMissingName(missing: IamMissing) {
  return missing === 'apiKey' ? 'AGT_KNOWLEDGE_BASE_IAM_API_KEY' : `iam.${missing}`;
}

/** A traveller IAM authenticated and authorized for this app. */
export interface IamTraveller {
  travellerId: string;
  travellerName: string;
  /** `applicationAuthorization.permissionAssigned`. */
  permission: string;
  /** The role `iam.roleMap` (or `iam.defaultRole`) gives the permission. */
  role: Role;
  /** IAM's `traveller.securityLevel` (#70). */
  securityLevel: SecurityLevel;
  /** IAM's `metadata.expiresIn`, in seconds, when it gave a readable one. */
  expiresInSeconds?: number;
}

export interface IamVerifier {
  verify(travellerName: string, password: string): Promise<IamTraveller>;
}

export interface IamLog {
  error(message: string): void;
  warn(message: string): void;
}

/** The parts of the `200` body the app uses; IAM may send more. */
const VerifyResponse = Type.Object({
  authenticated: Type.Boolean(),
  traveller: Type.Optional(Type.Object({
    travellerName: Type.Optional(Type.String()),
    agtTravellerId: Type.String({ minLength: 1, maxLength: 200 }),
    /** "0"-"5" (#70); checked in `traveller()`, so a bad value has its own log line. */
    securityLevel: Type.Optional(Type.Unknown()),
  })),
  applicationAuthorization: Type.Optional(Type.Object({
    requestedAppId: Type.Optional(Type.String()),
    permissionAssigned: Type.Optional(Type.String({ maxLength: 200 })),
    isAuthorized: Type.Boolean(),
  })),
  metadata: Type.Optional(Type.Object({ expiresIn: Type.Optional(Type.Union([Type.String(), Type.Number()])) })),
});

/** The most of a response body that is read; IAM's answers are a few kilobytes. */
const maxResponseBytes = 64 * 1024;

const credentialCodes = new Set(['ERR_IDENTITY_NOT_FOUND', 'ERR_INVALID_CREDENTIALS']);
const noAccessTiers = new Set(['NOACCESS', 'NONE']);

export function invalidIamCredentials(): never {
  throw new HttpError(401, 'invalid_credentials', 'Invalid Traveller Name or password.');
}

export function iamUnavailable(): HttpError {
  return new HttpError(503, 'iam_unavailable', 'AGT sign-in is unavailable. Try again later or ask the administrator.');
}

function badGateway() {
  return new HttpError(502, 'iam_bad_gateway', 'The AGT sign-in service answered unexpectedly. Try again later.');
}

function accessDenied() {
  return new HttpError(403, 'app_access_denied', 'Your AGT account is not authorized for the Knowledge Base.');
}

/** `24h`, `90m`, `3600s`, `2d` or a number of seconds. */
export function parseExpiresIn(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
  if (typeof value !== 'string') return undefined;
  const match = /^\s*(\d{1,9})\s*([smhd]?)\s*$/i.exec(value);
  if (!match) return undefined;
  const seconds = Number(match[1]) * ({ '': 1, s: 1, m: 60, h: 3600, d: 86_400 } as Record<string, number>)[match[2].toLowerCase()];
  return seconds > 0 ? seconds : undefined;
}

/** IAM's security level: the string "0"-"5" (an integer 0-5 is accepted too), else undefined. */
export function parseSecurityLevel(value: unknown): SecurityLevel | undefined {
  const level = typeof value === 'string' && /^[0-5]$/.test(value) ? Number(value) : value;
  return isSecurityLevel(level) ? level : undefined;
}

/** The upstream error code, if it looks like one; only this ever reaches the log. */
function upstreamCode(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) return undefined;
  for (const key of ['code', 'error', 'errorCode']) {
    const value = (body as Record<string, unknown>)[key];
    if (typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(value)) return value;
  }
  return undefined;
}

/** `Retry-After` in seconds (1–3600), or 60 when IAM gives none or a date. */
function retryAfter(header: string | null) {
  const seconds = header && /^\d{1,6}$/.test(header.trim()) ? Number(header.trim()) : 60;
  return Math.min(3600, Math.max(1, seconds));
}

async function readBody(response: Response): Promise<unknown> {
  if (!response.body) return undefined;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxResponseBytes) {
      await reader.cancel();
      throw badGateway();
    }
    chunks.push(value);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * Calls `POST {iam.baseUrl}/api/v1/auth/verify` and maps the answer to a
 * traveller or an `HttpError` (the table in issue #30). The traveller's
 * password and the API key are never logged; only IAM's error code is.
 */
export class IamClient implements IamVerifier {
  constructor(
    private readonly context: Pick<AppContext, 'config' | 'iamApiKey'>,
    private readonly log: IamLog,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async verify(travellerName: string, password: string): Promise<IamTraveller> {
    const { iam } = this.context.config;
    const apiKey = this.context.iamApiKey;
    if (!iam.baseUrl || !iam.appId || !apiKey) throw iamUnavailable();
    const base = iam.baseUrl.endsWith('/') ? iam.baseUrl : `${iam.baseUrl}/`;
    const url = new URL('api/v1/auth/verify', base);

    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify({ identifier: travellerName, password, appId: iam.appId }),
        redirect: 'error',
        signal: AbortSignal.timeout(iam.timeoutSeconds * 1000),
      });
    } catch (error) {
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        this.log.error(`AGT IAM did not answer within ${iam.timeoutSeconds} seconds.`);
        throw new HttpError(504, 'iam_timeout', 'The AGT sign-in service did not answer in time. Try again later.');
      }
      this.log.error(`AGT IAM could not be reached${error instanceof Error && error.cause instanceof Error && 'code' in error.cause ? ` (${String(error.cause.code)})` : ''}.`);
      throw badGateway();
    }

    let body: unknown;
    try {
      body = await readBody(response);
    } catch (error) {
      if (error instanceof HttpError) {
        this.log.error('AGT IAM sent a response larger than 64 KiB.');
        throw error;
      }
      if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
        this.log.error(`AGT IAM did not finish its answer within ${iam.timeoutSeconds} seconds.`);
        throw new HttpError(504, 'iam_timeout', 'The AGT sign-in service did not answer in time. Try again later.');
      }
      this.log.error('AGT IAM closed the connection while answering.');
      throw badGateway();
    }
    const code = upstreamCode(body);

    if (response.status === 200) return this.traveller(body);
    if (response.status === 400) {
      throw new HttpError(400, 'validation_failed', 'Enter your Traveller Name and password.');
    }
    if (response.status === 401 && (code === undefined || credentialCodes.has(code))) {
      if (code === undefined) this.log.warn('AGT IAM refused a sign-in with 401 and no error code; treated as invalid credentials.');
      invalidIamCredentials();
    }
    if (response.status === 401 || response.status === 403) {
      this.log.error(`AGT IAM refused this app (${response.status} ${code ?? 'without an error code'}): check iam.appId, the API key and the app's auth:verify capability.`);
      throw iamUnavailable();
    }
    if (response.status === 429) {
      this.log.warn('AGT IAM rate-limited a sign-in.');
      throw new RateLimitedError(retryAfter(response.headers.get('retry-after')));
    }
    this.log.error(`AGT IAM answered ${response.status}${code ? ` ${code}` : ''}.`);
    throw badGateway();
  }

  private traveller(body: unknown): IamTraveller {
    const { iam } = this.context.config;
    if (!Value.Check(VerifyResponse, body)) {
      this.log.error('AGT IAM sent a sign-in answer the app does not understand.');
      throw badGateway();
    }
    if (!body.authenticated) invalidIamCredentials();
    const authorization = body.applicationAuthorization;
    if (!body.traveller || !authorization) {
      this.log.error('AGT IAM sent a sign-in answer without the traveller or the authorization.');
      throw badGateway();
    }
    if (authorization.requestedAppId !== undefined && authorization.requestedAppId !== iam.appId) {
      this.log.error('AGT IAM answered for a different App ID than iam.appId.');
      throw badGateway();
    }
    const permission = (authorization.permissionAssigned ?? '').trim();
    if (!authorization.isAuthorized || !permission || noAccessTiers.has(permission.toUpperCase())) throw accessDenied();
    const securityLevel = parseSecurityLevel(body.traveller.securityLevel);
    if (securityLevel === undefined) {
      // Never guess a level: a missing or unknown one could grant too much (#70).
      this.log.error('AGT IAM sent no valid traveller.securityLevel (expected "0" to "5"); the sign-in was refused.');
      throw badGateway();
    }
    const name = [...(body.traveller.travellerName ?? '').trim()].slice(0, 42).join('');
    return {
      travellerId: body.traveller.agtTravellerId,
      travellerName: name,
      permission,
      role: iam.roleMap[permission] ?? iam.defaultRole,
      securityLevel,
      expiresInSeconds: parseExpiresIn(body.metadata?.expiresIn),
    };
  }
}
