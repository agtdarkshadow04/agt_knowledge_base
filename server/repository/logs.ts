import type { Sql } from './control.js';

/**
 * The SQL of the log store (SRV-4, LOG-1): the `logs` schema's server log,
 * audit log and `log_meta`. `server/logs.ts` and `server/audit.ts` hold the rules.
 */

export type ServerLevel = 'info' | 'warn' | 'error' | 'fatal';
export const serverLevels: readonly ServerLevel[] = ['info', 'warn', 'error', 'fatal'];
export type AuditOutcome = 'success' | 'denied' | 'rate_limited' | 'failure';
export type ActorType = 'admin' | 'member' | 'anonymous';

export interface ServerEntry {
  id: string;
  at: Date;
  level: ServerLevel;
  source: string;
  message: string;
  requestId: string | null;
  details: Record<string, unknown>;
}

export interface AuditEntry {
  id: string;
  at: Date;
  lastAt: Date;
  count: number;
  actorType: ActorType;
  actor: string | null;
  ipHash: string | null;
  client: 'web' | 'api';
  action: string;
  method: string;
  route: string;
  targetType: string | null;
  targetId: string | null;
  outcome: AuditOutcome;
  statusCode: number;
  requestId: string | null;
  details: Record<string, unknown>;
}

/** The position after the last item of a page: newest first, then by id (API-8). */
export interface LogCursor {
  at: string;
  id: string;
}

export interface ServerFilters {
  /** Minimum level. */
  level?: ServerLevel;
  source?: string;
  from?: Date;
  to?: Date;
  q?: string;
}

export interface AuditFilters {
  actorType?: ActorType;
  action?: string;
  outcome?: AuditOutcome;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  q?: string;
}

// --- log_meta -----------------------------------------------------------------

export async function readMeta(sql: Sql, key: string) {
  return (await sql.query<{ value: string }>('SELECT value FROM logs.log_meta WHERE key = $1', [key])).rows[0]?.value;
}

export async function writeMeta(sql: Sql, key: string, value: string) {
  await sql.query(
    'INSERT INTO logs.log_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value',
    [key, value],
  );
}

/** Stores `value` unless the key exists, and returns the stored value: the first process to start wins. */
export async function insertMetaOnce(sql: Sql, key: string, value: string) {
  await sql.query('INSERT INTO logs.log_meta (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [key, value]);
  return (await readMeta(sql, key))!;
}

// --- writes -------------------------------------------------------------------

export async function insertServerEntries(sql: Sql, entries: readonly ServerEntry[]) {
  if (!entries.length) return;
  await sql.query(
    `INSERT INTO logs.server_log (id, at, level, source, message, request_id, details)
     SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::text[], $4::text[], $5::text[], $6::text[], $7::jsonb[])`,
    [
      entries.map((entry) => entry.id),
      entries.map((entry) => entry.at),
      entries.map((entry) => entry.level),
      entries.map((entry) => entry.source),
      entries.map((entry) => entry.message),
      entries.map((entry) => entry.requestId),
      entries.map((entry) => JSON.stringify(entry.details)),
    ],
  );
}

/**
 * Coalescing (LOG-11): a failure, denial or rate limit identical in action,
 * outcome, status and address to one written in the last 60 seconds bumps that
 * entry's `count` and `last_at`. True when an entry was bumped.
 */
export async function coalesceAudit(sql: Sql, entry: AuditEntry) {
  const result = await sql.query(
    `UPDATE logs.audit_log SET count = count + 1, last_at = $5
     WHERE id = (
       SELECT id FROM logs.audit_log
       WHERE action = $1 AND outcome = $2 AND status_code = $3 AND ip_hash IS NOT DISTINCT FROM $4
         AND last_at > $5::timestamptz - interval '60 seconds'
       ORDER BY last_at DESC
       LIMIT 1
     )`,
    [entry.action, entry.outcome, entry.statusCode, entry.ipHash, entry.at],
  );
  return Boolean(result.rowCount);
}

export async function insertAudit(sql: Sql, entry: AuditEntry) {
  await sql.query(
    `INSERT INTO logs.audit_log (id, at, last_at, count, actor_type, actor, ip_hash, client, action, method, route,
       target_type, target_id, outcome, status_code, request_id, details)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
    [
      entry.id, entry.at, entry.lastAt, entry.count, entry.actorType, entry.actor, entry.ipHash, entry.client,
      entry.action, entry.method, entry.route, entry.targetType, entry.targetId, entry.outcome, entry.statusCode,
      entry.requestId, JSON.stringify(entry.details),
    ],
  );
}

// --- reads --------------------------------------------------------------------

/** `%`, `_` and `\` match themselves in an ILIKE pattern. */
function containing(text: string) {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`;
}

interface Where {
  clauses: string[];
  values: unknown[];
}

function where(): Where {
  return { clauses: [], values: [] };
}

function add(filter: Where, clause: (placeholder: string) => string, value: unknown) {
  filter.values.push(value);
  filter.clauses.push(clause(`$${filter.values.length}`));
}

function serverWhere(filters: ServerFilters, after: LogCursor | null) {
  const filter = where();
  if (filters.level) add(filter, (p) => `level = ANY(${p}::text[])`, serverLevels.slice(serverLevels.indexOf(filters.level)));
  if (filters.source) add(filter, (p) => `source = ${p}`, filters.source);
  if (filters.from) add(filter, (p) => `at >= ${p}`, filters.from);
  if (filters.to) add(filter, (p) => `at < ${p}`, filters.to);
  if (filters.q) add(filter, (p) => `message ILIKE ${p}`, containing(filters.q));
  if (after) {
    filter.values.push(after.at, after.id);
    filter.clauses.push(`(at, id) < ($${filter.values.length - 1}::timestamptz, $${filter.values.length}::uuid)`);
  }
  return filter;
}

function auditWhere(filters: AuditFilters, after: LogCursor | null) {
  const filter = where();
  if (filters.actorType) add(filter, (p) => `actor_type = ${p}`, filters.actorType);
  if (filters.action) add(filter, (p) => `action = ${p}`, filters.action);
  if (filters.outcome) add(filter, (p) => `outcome = ${p}`, filters.outcome);
  if (filters.targetType) add(filter, (p) => `target_type = ${p}`, filters.targetType);
  if (filters.targetId) add(filter, (p) => `target_id = ${p}`, filters.targetId);
  if (filters.from) add(filter, (p) => `at >= ${p}`, filters.from);
  if (filters.to) add(filter, (p) => `at < ${p}`, filters.to);
  if (filters.q) {
    add(filter, (p) => `(actor ILIKE ${p} OR action ILIKE ${p} OR target_type ILIKE ${p} OR target_id ILIKE ${p} OR details::text ILIKE ${p})`, containing(filters.q));
  }
  if (after) {
    filter.values.push(after.at, after.id);
    filter.clauses.push(`(at, id) < ($${filter.values.length - 1}::timestamptz, $${filter.values.length}::uuid)`);
  }
  return filter;
}

function whereClause(filter: Where) {
  return filter.clauses.length ? `WHERE ${filter.clauses.join(' AND ')}` : '';
}

interface ServerRow {
  id: string;
  at: Date;
  level: ServerLevel;
  source: string;
  message: string;
  request_id: string | null;
  details: Record<string, unknown>;
}

interface AuditRow {
  id: string;
  at: Date;
  last_at: Date;
  count: number;
  actor_type: ActorType;
  actor: string | null;
  ip_hash: string | null;
  client: 'web' | 'api';
  action: string;
  method: string;
  route: string;
  target_type: string | null;
  target_id: string | null;
  outcome: AuditOutcome;
  status_code: number;
  request_id: string | null;
  details: Record<string, unknown>;
}

const toServer = (row: ServerRow): ServerEntry => ({
  id: row.id, at: row.at, level: row.level, source: row.source, message: row.message, requestId: row.request_id, details: row.details,
});

const toAudit = (row: AuditRow): AuditEntry => ({
  id: row.id, at: row.at, lastAt: row.last_at, count: row.count, actorType: row.actor_type, actor: row.actor,
  ipHash: row.ip_hash, client: row.client, action: row.action, method: row.method, route: row.route,
  targetType: row.target_type, targetId: row.target_id, outcome: row.outcome, statusCode: row.status_code,
  requestId: row.request_id, details: row.details,
});

/** One page of the server log, newest first. */
export async function listServer(sql: Sql, filters: ServerFilters, after: LogCursor | null, limit: number) {
  const filter = serverWhere(filters, after);
  filter.values.push(limit);
  const result = await sql.query<ServerRow>(
    `SELECT id, at, level, source, message, request_id, details FROM logs.server_log
     ${whereClause(filter)} ORDER BY at DESC, id DESC LIMIT $${filter.values.length}`,
    filter.values,
  );
  return result.rows.map(toServer);
}

/** One page of the audit log, newest first. */
export async function listAudit(sql: Sql, filters: AuditFilters, after: LogCursor | null, limit: number) {
  const filter = auditWhere(filters, after);
  filter.values.push(limit);
  const result = await sql.query<AuditRow>(
    `SELECT id, at, last_at, count, actor_type, actor, ip_hash, client, action, method, route, target_type, target_id,
       outcome, status_code, request_id, details
     FROM logs.audit_log ${whereClause(filter)} ORDER BY at DESC, id DESC LIMIT $${filter.values.length}`,
    filter.values,
  );
  return result.rows.map(toAudit);
}

/** Warnings and errors (error and fatal) after `since` (LOG-21). */
export async function countUnseen(sql: Sql, since: Date | null) {
  const result = await sql.query<{ warnings: string; errors: string }>(
    `SELECT count(*) FILTER (WHERE level = 'warn') AS warnings, count(*) FILTER (WHERE level IN ('error', 'fatal')) AS errors
     FROM logs.server_log WHERE level IN ('warn', 'error', 'fatal') AND ($1::timestamptz IS NULL OR at > $1)`,
    [since],
  );
  return { unseenWarnings: Number(result.rows[0].warnings), unseenErrors: Number(result.rows[0].errors) };
}

/** LOG-20: the Admin clears the server log. The audit log has no such function. */
export async function clearServer(sql: Sql) {
  return (await sql.query('DELETE FROM logs.server_log')).rowCount ?? 0;
}

// --- retention (LOG-15) ----------------------------------------------------------

export async function deleteServerOlderThan(sql: Sql, cutoff: Date) {
  return (await sql.query('DELETE FROM logs.server_log WHERE at < $1', [cutoff])).rowCount ?? 0;
}

export async function deleteAuditOlderThan(sql: Sql, cutoff: Date) {
  return (await sql.query('DELETE FROM logs.audit_log WHERE at < $1', [cutoff])).rowCount ?? 0;
}

/** Deletes the oldest server entries beyond `cap`. */
export async function capServer(sql: Sql, cap: number) {
  const result = await sql.query(
    `DELETE FROM logs.server_log WHERE id IN (
       SELECT id FROM logs.server_log ORDER BY at, id
       LIMIT GREATEST(0, (SELECT count(*) FROM logs.server_log) - $1)
     )`,
    [cap],
  );
  return result.rowCount ?? 0;
}

/** Deletes the oldest audit entries beyond `cap`: denied, rate-limited and failed ones first, successes last. */
export async function capAudit(sql: Sql, cap: number) {
  const result = await sql.query(
    `DELETE FROM logs.audit_log WHERE id IN (
       SELECT id FROM logs.audit_log ORDER BY (outcome = 'success'), at, id
       LIMIT GREATEST(0, (SELECT count(*) FROM logs.audit_log) - $1)
     )`,
    [cap],
  );
  return result.rowCount ?? 0;
}
