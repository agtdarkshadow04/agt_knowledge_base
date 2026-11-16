import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { isIPv4, isIPv6 } from 'node:net';
import { Readable, Writable } from 'node:stream';
import pino from 'pino';
import type { AppConfig } from './config.js';
import { dataWriteScope, type Database } from './db.js';
import * as repo from './repository/logs.js';
import type { AuditEntry, AuditFilters, LogCursor, ServerEntry, ServerFilters, ServerLevel } from './repository/logs.js';

/**
 * The log store (§13): the server log and the audit log in the `logs` schema
 * (LOG-1), the pino logger that writes to stdout and the server log (LOG-5),
 * IP pseudonymization (LOG-12), retention (LOG-15) and exports (LOG-22).
 */

export type { AuditEntry, ServerEntry } from './repository/logs.js';

/** Where a failure to write the log store is reported, once (LOG-3). Never the logger itself. */
export type FailureReporter = (message: string) => void;

const pinoLevels: Record<number, ServerLevel> = { 30: 'info', 40: 'warn', 50: 'error', 60: 'fatal' };
/** pino's fields that are not details (LOG-7). */
const recordFields = new Set(['level', 'time', 'pid', 'hostname', 'msg', 'source', 'reqId', 'req', 'res', 'err', 'responseTime', 'route']);
const maxBuffered = 1000;

const ipKeyName = 'ip_hash_key';
const seenKeyName = 'server_log_seen_at';

/**
 * LOG-12: the client address to hash. IPv4-mapped IPv6 becomes IPv4; other
 * IPv6 addresses keep only their /64 prefix.
 */
export function normalizeAddress(address: string) {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped && isIPv4(mapped[1])) return mapped[1];
  if (!isIPv6(address)) return address;
  const [head, tail = ''] = address.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const groups = address.includes('::') ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((group) => Number.parseInt(group || '0', 16).toString(16)).join(':')}::/64`;
}

/** A pino record (one JSON line) as a server log entry; levels below info give null (LOG-5, LOG-7, LOG-9). */
export function serverEntryFromRecord(record: Record<string, unknown>): ServerEntry | null {
  const level = pinoLevels[Number(record.level)];
  if (!level) return null;
  const details: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) if (!recordFields.has(key)) details[key] = value;
  const error = record.err as { type?: string; message?: string; stack?: string } | undefined;
  // LOG-9: an error's name, message, stack and route only; never headers or bodies.
  if (error && typeof error === 'object') {
    details.error = { name: error.type, message: error.message, stack: error.stack };
    if (typeof record.route === 'string') details.route = record.route;
  }
  const requestId = typeof record.reqId === 'string' ? record.reqId : null;
  return {
    id: randomUUID(),
    at: new Date(typeof record.time === 'number' ? record.time : Date.now()),
    level,
    source: typeof record.source === 'string' ? record.source : requestId ? 'http' : 'server',
    message: typeof record.msg === 'string' ? record.msg : '',
    requestId,
    details,
  };
}

export interface LogStoreOptions {
  report?: FailureReporter;
  now?: () => Date;
}

/** The log store of one process. Writes never fail a request or the server (LOG-3). */
export class LogStore {
  private buffer: ServerEntry[] = [];
  private ready = false;
  private flushing: Promise<void> | null = null;
  private ipKey: Buffer | null = null;
  private failureReported = false;
  private readonly report: FailureReporter;
  private readonly now: () => Date;

  constructor(private readonly db: Pick<Database, 'pool'>, options: LogStoreOptions = {}) {
    this.report = options.report ?? (() => undefined);
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Log writes never join a data write's transaction: they must stay even
   * when the write rolls back, and must not delay its commit.
   */
  private async sql() {
    return dataWriteScope.exit(() => this.db.pool());
  }

  private failed(what: string, error: unknown) {
    if (this.failureReported) return;
    this.failureReported = true;
    this.report(`The log store could not ${what}: ${error instanceof Error ? error.message : String(error)}. Further failures are not reported.`);
  }

  /** Once the startup migrations have created the log store: loads the IP-hash key and flushes what was logged before. */
  async open() {
    try {
      const pool = await this.sql();
      this.ipKey = Buffer.from(await repo.insertMetaOnce(pool, ipKeyName, randomBytes(32).toString('hex')), 'hex');
    } catch (error) {
      this.failed('be opened', error);
    }
    this.ready = true;
    await this.flush();
  }

  /** Queues a server log entry; entries logged before `open()` wait in a bounded buffer. */
  enqueue(entry: ServerEntry) {
    if (this.buffer.length >= maxBuffered) this.buffer.shift();
    this.buffer.push(entry);
    if (this.ready && !this.flushing) this.flushing = new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.flush());
  }

  /** Writes the queued entries; resolves when the queue is empty. */
  async flush(): Promise<void> {
    while (this.ready && this.buffer.length) {
      const batch = this.buffer.splice(0, 100);
      try {
        await repo.insertServerEntries(await this.sql(), batch);
      } catch (error) {
        this.failed('write the server log', error);
      }
    }
    this.flushing = null;
  }

  /** LOG-12: the first 16 hex characters of HMAC-SHA256(key, address). */
  ipHash(address: string | undefined) {
    if (!address || !this.ipKey) return null;
    return createHmac('sha256', this.ipKey).update(normalizeAddress(address)).digest('hex').slice(0, 16);
  }

  /** Writes an audit entry, coalescing repeated failures (LOG-11). Never throws (LOG-3). */
  async audit(entry: Omit<AuditEntry, 'id' | 'at' | 'lastAt' | 'count'>) {
    const at = this.now();
    const full: AuditEntry = { ...entry, id: randomUUID(), at, lastAt: at, count: 1 };
    try {
      const pool = await this.sql();
      if (full.outcome !== 'success' && await repo.coalesceAudit(pool, full)) return;
      await repo.insertAudit(pool, full);
    } catch (error) {
      this.failed('write the audit log', error);
    }
  }

  async listServer(filters: ServerFilters, after: LogCursor | null, limit: number) {
    return repo.listServer(await this.sql(), filters, after, limit);
  }

  async listAudit(filters: AuditFilters, after: LogCursor | null, limit: number) {
    return repo.listAudit(await this.sql(), filters, after, limit);
  }

  async summary() {
    const pool = await this.sql();
    const seen = await repo.readMeta(pool, seenKeyName);
    return repo.countUnseen(pool, seen ? new Date(seen) : null);
  }

  async markSeen() {
    await repo.writeMeta(await this.sql(), seenKeyName, this.now().toISOString());
  }

  async clearServer() {
    return repo.clearServer(await this.sql());
  }

  /**
   * LOG-15: deletes entries older than the retention periods, then the oldest
   * beyond the caps (for the audit log, failures before successes).
   */
  async applyRetention(settings: RetentionSettings) {
    const pool = await this.sql();
    const day = 24 * 60 * 60 * 1000;
    const now = this.now().getTime();
    const server = await repo.deleteServerOlderThan(pool, new Date(now - settings.serverRetentionDays * day))
      + await repo.capServer(pool, settings.serverMaxEntries);
    const audit = await repo.deleteAuditOlderThan(pool, new Date(now - settings.auditRetentionDays * day))
      + await repo.capAudit(pool, settings.auditMaxEntries);
    return { server, audit };
  }
}

/** What the routes and the audit hook use of the log store; tests use a fake. */
export type LogSink = Pick<LogStore, 'audit' | 'ipHash' | 'listServer' | 'listAudit' | 'summary' | 'markSeen' | 'clearServer'>;

/**
 * LOG-15: retention at startup and then every hour. A run that deletes
 * anything writes one server log entry with the counts. It skips while a
 * restore runs or has failed (BAK-8: background jobs pause).
 */
export function startRetention(
  store: Pick<LogStore, 'applyRetention'>,
  settings: () => Promise<RetentionSettings>,
  log: { info(details: object, message: string): void; error(details: object, message: string): void },
  paused: () => boolean,
) {
  const run = async () => {
    if (paused()) return;
    try {
      const deleted = await store.applyRetention(await settings());
      if (deleted.server || deleted.audit) {
        log.info({ source: 'retention', deleted }, `Retention deleted ${deleted.server} server log and ${deleted.audit} audit log entries.`);
      }
    } catch (error) {
      log.error({ source: 'retention', err: error }, 'Log retention failed.');
    }
  };
  const first = run();
  const timer = setInterval(() => void run(), 60 * 60 * 1000);
  timer.unref();
  return { first, stop: () => clearInterval(timer) };
}

export interface RetentionSettings {
  serverRetentionDays: number;
  serverMaxEntries: number;
  auditRetentionDays: number;
  auditMaxEntries: number;
}

/** The stream behind the logger that feeds the server log: info and above, parsed from pino's JSON lines (LOG-5). */
export function logStoreStream(store: Pick<LogStore, 'enqueue'>, report: FailureReporter = () => undefined) {
  let reported = false;
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      try {
        for (const line of String(chunk).split('\n')) {
          if (!line.trim()) continue;
          const entry = serverEntryFromRecord(JSON.parse(line) as Record<string, unknown>);
          if (entry) store.enqueue(entry);
        }
      } catch (error) {
        if (!reported) {
          reported = true;
          report(`A log line could not be stored: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      callback();
    },
  });
}

const levelValues: Record<string, number> = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60, silent: Infinity };

/** Paths pino never logs (SRV-6, LOG-9). */
export const redactedPaths = ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'];

/**
 * LOG-5: the logger Fastify gets as `loggerInstance`. stdout follows
 * `server.logLevel`; the log store gets info and above whatever that level is.
 */
export function createLogger(config: Pick<AppConfig, 'server'>, stdout: NodeJS.WritableStream, store: Writable) {
  const stdoutLevel = config.server.logLevel;
  const streams: pino.StreamEntry[] = [{ level: 'info', stream: store }];
  if (stdoutLevel !== 'silent') streams.push({ level: stdoutLevel as pino.Level, stream: stdout });
  const level = levelValues[stdoutLevel] < levelValues.info ? stdoutLevel : 'info';
  return pino({ level, redact: redactedPaths }, pino.multistream(streams));
}

// --- Exports (LOG-22) -----------------------------------------------------------------

export type ExportFormat = 'jsonl' | 'csv';

/** LOG-22: a cell starting with `=`, `+`, `-`, `@`, tab or carriage return gets a leading quote. */
export function csvCell(value: unknown) {
  let text = value === null || value === undefined ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const serverColumns = ['id', 'at', 'level', 'source', 'message', 'requestId', 'details'] as const;
export const auditColumns = [
  'id', 'at', 'lastAt', 'count', 'actorType', 'actor', 'ipHash', 'client', 'action', 'method', 'route',
  'targetType', 'targetId', 'outcome', 'statusCode', 'requestId', 'details',
] as const;

function serialize(entry: object): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entry).map(([key, value]) => [key, value instanceof Date ? value.toISOString() : value]));
}

/**
 * A streamed export of every entry matching the filters, newest first, read
 * in pages so the whole log is never held in memory.
 */
export function exportStream<Entry extends { at: Date; id: string }>(
  page: (after: LogCursor | null, limit: number) => Promise<Entry[]>,
  format: ExportFormat,
  columns: readonly string[],
) {
  let after: LogCursor | null = null;
  let started = false;
  let done = false;
  return new Readable({
    async read() {
      try {
        if (!started) {
          started = true;
          if (format === 'csv') {
            this.push(`${columns.join(',')}\r\n`);
            return;
          }
        }
        if (done) {
          this.push(null);
          return;
        }
        const rows = await page(after, 500);
        if (rows.length < 500) done = true;
        if (!rows.length) {
          this.push(null);
          return;
        }
        after = { at: rows.at(-1)!.at.toISOString(), id: rows.at(-1)!.id };
        const text = rows.map((row) => {
          const record = serialize(row);
          return format === 'jsonl'
            ? `${JSON.stringify(record)}\n`
            : `${columns.map((column) => csvCell(record[column])).join(',')}\r\n`;
        }).join('');
        this.push(text);
      } catch (error) {
        this.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

/** `agt-knowledge-base-<server|audit>-log-<timestamp>.<ext>` (LOG-22). */
export function exportFileName(log: 'server' | 'audit', format: ExportFormat, date: Date) {
  return `agt-knowledge-base-${log}-log-${date.toISOString().replace(/[:.]/g, '-')}.${format}`;
}

// --- Cursors (API-8) ---------------------------------------------------------------------

export function encodeLogCursor(entry: { at: Date; id: string }) {
  return Buffer.from(JSON.stringify([entry.at.toISOString(), entry.id])).toString('base64url');
}

/** Decodes a log cursor; null for a malformed one, which the caller answers with `400 invalid_request`. */
export function decodeLogCursor(cursor: string): LogCursor | null {
  try {
    const parts: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
    if (!Array.isArray(parts) || parts.length !== 2) return null;
    const [at, id] = parts as unknown[];
    if (typeof at !== 'string' || Number.isNaN(Date.parse(at)) || typeof id !== 'string') return null;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) return null;
    return { at, id };
  } catch {
    return null;
  }
}
