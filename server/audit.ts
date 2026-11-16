import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ActorType, AuditOutcome } from './repository/logs.js';
import type { LogSink } from './logs.js';

/**
 * The audit log (LOG-10..LOG-14). One `onResponse` hook writes every entry, so
 * no route can be forgotten. Handlers only add the target and a summary of the
 * change through `request.audit` (or `ApiResponse.audit`).
 */

/** What a handler adds to its request's audit entry. Never secrets or bulk content (LOG-14). */
export interface AuditInfo {
  /** Who acted, when the session does not say (a sign-in or setup that just succeeded). */
  actorType?: ActorType;
  actor?: string | null;
  targetType?: string;
  targetId?: string;
  details?: Record<string, unknown>;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by handlers; the audit hook adds everything else. */
    audit: AuditInfo | null;
    /** The error code and failed field names of an error response, set by the error handler. */
    auditError: { error: string; fields?: string[] } | null;
  }
  interface FastifyContextConfig {
    /** A GET route that is audited: a sensitive read such as a download or an export (LOG-11). */
    audit?: boolean;
  }
}

/** LOG-10: the outcome of a status code. */
export function auditOutcome(statusCode: number): AuditOutcome {
  if (statusCode < 400) return 'success';
  if (statusCode === 401 || statusCode === 403) return 'denied';
  if (statusCode === 429) return 'rate_limited';
  return 'failure';
}

/** The path parameter that names the affected resource, by name. */
const targetParameters: Record<string, string> = { tagId: 'tag', userId: 'member' };

/** The kind of resource a route's path is about. */
function resourceType(path: string) {
  if (path.startsWith('/api/articles')) return 'article';
  if (path.startsWith('/api/tags')) return 'tag';
  if (path.startsWith('/api/admin/users')) return 'member';
  return null;
}

function defaultTarget(request: FastifyRequest, path: string): { targetType?: string | null; targetId?: string } {
  const params = request.params as Record<string, string>;
  if (params.id) return { targetType: resourceType(path), targetId: params.id };
  for (const [name, type] of Object.entries(targetParameters)) if (params[name]) return { targetType: type, targetId: params[name] };
  return {};
}

/**
 * LOG-11: audits every request to a non-GET route, GET routes marked
 * `audit: true`, every 401/403 from an admin route and every 429. Ordinary
 * reads and unknown routes are not audited. A failure to write never fails the
 * request (LOG-3).
 */
export function auditHook(logs: Pick<LogSink, 'audit' | 'ipHash'>) {
  return async function audit(request: FastifyRequest, reply: FastifyReply) {
    const route = request.routeOptions.config.apiRoute;
    if (!route) return;
    const statusCode = reply.statusCode;
    const audited = route.method !== 'GET'
      || route.audit === true
      || (route.admin && (statusCode === 401 || statusCode === 403))
      || statusCode === 429;
    if (!audited) return;
    const info = request.audit ?? {};
    const actorType: ActorType = info.actorType ?? (request.admin ? 'admin' : request.member ? 'member' : 'anonymous');
    const actor = info.actor !== undefined ? info.actor : request.admin?.username ?? request.member?.username ?? null;
    const target = info.targetId ? { targetType: info.targetType ?? resourceType(route.path), targetId: info.targetId } : defaultTarget(request, route.path);
    const details = { ...info.details, ...(request.auditError ? request.auditError : {}) };
    await logs.audit({
      actorType,
      actor,
      ipHash: logs.ipHash(request.ip),
      client: request.headers['x-agt-client'] === 'web' ? 'web' : 'api',
      action: route.operationId,
      method: route.method,
      route: request.routeOptions.url ?? route.path,
      targetType: target.targetType ?? null,
      targetId: target.targetId ?? null,
      outcome: auditOutcome(statusCode),
      statusCode,
      requestId: request.id,
      details,
    });
  };
}

/** Body properties that name the resource; their values are short and never secret (LOG-14). */
const namingFields = ['title', 'name', 'username'];

/**
 * LOG-14 defaults for a write: the resource's name or title and the field
 * names the request sent, never their values; the created resource's id.
 */
export function writeSummary(body: unknown, result: unknown): AuditInfo {
  const info: AuditInfo = {};
  const details: Record<string, unknown> = {};
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const record = body as Record<string, unknown>;
    details.fields = Object.keys(record).sort();
    for (const field of namingFields) {
      if (typeof record[field] === 'string') details[field] = (record[field] as string).slice(0, 200);
    }
  }
  if (result && typeof result === 'object' && typeof (result as { id?: unknown }).id === 'string') {
    info.targetId = (result as { id: string }).id;
  }
  if (Object.keys(details).length) info.details = details;
  return info;
}
