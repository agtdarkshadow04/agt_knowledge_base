import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Readable } from 'node:stream';
import type pg from 'pg';
import { z } from 'zod';
import { lockedSettingKeys, type AppContext } from './context.js';
import { applyAppMigrations, migrationId, MIGRATIONS, schemaVersion, type ConnectionParameters } from './db.js';
import { ping } from './repository.js';
import * as sqlBackup from './repository/backup.js';
import { advisoryUnlock, tryAdvisoryLock } from './repository/control.js';
import { restoreWarnings, type RestoreWarningCode } from './backupCodes.js';
import { ArchiveRejectedError, HttpError } from './http.js';
import { diffLines, type DiffLine } from './line-diff.js';
import type { OperationRun, Operations, RecoverySession } from './operation.js';
import { parseHash } from './passwords.js';
import { SettingsService } from './settings-service.js';
import { extractZip, fileDigest, writeZip, ZipRejectedError, type ExtractedEntry } from './zip.js';

/**
 * Backup and restore (§12, Postgres). A backup is a ZIP with `manifest.json`,
 * a `pg_dump` custom-format `database.dump` of the `public` schema without
 * session rows, and `config.yaml` (BAK-2). A restore validates the upload in
 * the preview database (BAK-3), then replaces the main database under the
 * shared operation lock (BAK-4, BAK-12), rolling back to the pre-restore
 * backup if anything fails (BAK-10, BAK-11). `config.yaml` is never written (BAK-5).
 */

export const backupFormat = 'agt-knowledge-base-backup';
/** BAK-7: the archive layout this version writes; it restores every version from 1 up to this one. */
export const backupFormatVersion = 1;

const manifestFile = 'manifest.json';
const databaseFile = 'database.dump';
const configFile = 'config.yaml';
/** Entries a 1.x archive has; read only to recognise and refuse it. */
const legacyDatabaseFile = 'database.json';

/** Every table of the schema; `schema_migrations` is allowed beside them (BAK-3). */
export const EXPECTED_TABLES = [
  'app_users',
  'local_users',
  'tags',
  'articles',
  'article_revisions',
  'settings',
  'admin',
  'sessions',
  'member_sessions',
] as const;

/** Tables whose rows a backup never contains (AUTH-8) and every restore empties (BAK-4 step 6.1). */
export const sessionTables = ['sessions', 'member_sessions'] as const;

const legacyArchiveMessage = 'This backup was made by AGT Knowledge Base 1.x. Restore it with version 1.x, then upgrade to 2.0.';
const restoreTimeoutMilliseconds = 10 * 60_000;
const preRestorePattern = /^pre-restore-backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.zip$/;

const manifestSchema = z.object({
  format: z.literal(backupFormat),
  formatVersion: z.number().int().min(1),
  appVersion: z.string().max(100),
  schemaVersion: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
  files: z.array(z.object({
    path: z.string().max(200),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict()).max(100),
}).strict();

export type BackupManifest = z.output<typeof manifestSchema>;

export interface RestorePreview {
  createdAt: string;
  appVersion: string;
  formatVersion: number;
  schemaVersion: { backup: number; current: number };
  /** Deprecated 1.x view of `schemaVersion`: migration ids in the backup and those the restore applies. */
  migrations: { backup: string[]; upgrade: string[] };
  counts: Record<string, number>;
  config: {
    /** Whether the backup contains a config.yaml. It is never restored (BAK-5). */
    included: boolean;
    content: string | null;
    /** Line diff from the current file to the backup's, or null when either is missing or too long. */
    diff: DiffLine[] | null;
    identical: boolean;
  };
  /** Dashboard settings in the backup that config.yaml now defines; a restore drops them (CFG-7). */
  ignoredSettings: string[];
  /** English text of each warning, for humans and logs. */
  warnings: string[];
  /** The same warnings as stable codes, for clients to translate (I18N-6). */
  warningCodes: RestoreWarningCode[];
}

export interface RestoreReport extends RestorePreview {
  /** The pre-restore backup of the replaced data, in `storage.backupsDir`; null for a recovery restore. */
  preRestoreBackup: string | null;
}

/** `2026-11-10T06-30-59-123Z` (BAK-2). */
export function fileTimestamp(date: Date) {
  return date.toISOString().replace(/[:.]/g, '-');
}

export function backupFileName(date: Date) {
  return `agt-knowledge-base-backup-${fileTimestamp(date)}.zip`;
}

// --- pg_dump and pg_restore (BAK-6) -------------------------------------------

export interface ToolResult {
  stdout: string;
}

/** Runs one of the PostgreSQL client tools. Tests replace it. */
export type ToolRunner = (tool: 'pg_dump' | 'pg_restore', args: string[], options: { signal?: AbortSignal; timeoutMilliseconds?: number }) => Promise<ToolResult>;

class ToolFailedError extends Error {
  constructor(tool: string, readonly stderr: string) {
    super(`${tool} failed${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : '.'}`);
    this.name = 'ToolFailedError';
  }
}

/**
 * Runs `pg_dump`/`pg_restore` as a child process, as the app role (BAK-6): the
 * password goes in the child's `PGPASSWORD`, never on the command line. A
 * timeout or an abort sends SIGTERM, then SIGKILL after 5 seconds.
 */
export function postgresTools(connection: ConnectionParameters, toolPath: string): ToolRunner {
  return (tool, args, options) => new Promise<ToolResult>((resolvePromise, reject) => {
    const child = spawn(tool, args, {
      env: {
        PATH: toolPath,
        PGHOST: connection.host,
        PGPORT: String(connection.port),
        PGUSER: connection.user,
        PGPASSWORD: connection.password,
        PGDATABASE: connection.database,
        PGSSLMODE: connection.ssl ? 'verify-full' : 'disable',
        ...(connection.ssl ? { PGSSLROOTCERT: 'system' } : {}),
        PGCONNECT_TIMEOUT: '10',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stderrBytes = 0;
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= 64 * 1024) stderr.push(chunk);
    });
    let killTimer: NodeJS.Timeout | undefined;
    let stopped: Error | undefined;
    const stop = (reason: Error) => {
      if (stopped) return;
      stopped = reason;
      child.kill('SIGTERM');
      killTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      killTimer.unref();
    };
    const timer = options.timeoutMilliseconds
      ? setTimeout(() => stop(new Error(`${tool} took longer than ${options.timeoutMilliseconds! / 60_000} minutes.`)), options.timeoutMilliseconds)
      : undefined;
    const onAbort = () => stop(options.signal?.reason instanceof Error ? options.signal.reason : new Error(`${tool} was stopped.`));
    if (options.signal?.aborted) onAbort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new ToolFailedError(tool, error.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
      if (stopped) reject(stopped);
      else if (code === 0) resolvePromise({ stdout: Buffer.concat(stdout).toString('utf8') });
      else reject(new ToolFailedError(tool, Buffer.concat(stderr).toString('utf8')));
    });
  });
}

/** The major version in `pg_dump (PostgreSQL) 16.4`. */
export function toolMajorVersion(output: string) {
  const match = /\(PostgreSQL\)\s+(\d+)/.exec(output);
  return match ? Number(match[1]) : null;
}

// --- The table of contents allowlist (BAK-3) -------------------------------------

/** TOC entry types, longest first so `TABLE DATA` is not read as `TABLE`. */
const tocTypes = [
  'SEQUENCE OWNED BY', 'MATERIALIZED VIEW DATA', 'MATERIALIZED VIEW', 'DEFAULT ACL', 'EVENT TRIGGER', 'FK CONSTRAINT',
  'SEQUENCE SET', 'TABLE DATA', 'TABLE ATTACH', 'INDEX ATTACH', 'LARGE OBJECT', 'BLOB', 'BLOBS', 'SCHEMA', 'TABLE',
  'SEQUENCE', 'DEFAULT', 'CONSTRAINT', 'INDEX', 'COMMENT', 'FUNCTION', 'PROCEDURE', 'AGGREGATE', 'TRIGGER', 'VIEW',
  'EXTENSION', 'ACL', 'RULE', 'POLICY', 'TYPE', 'DOMAIN', 'COLLATION', 'CONVERSION', 'OPERATOR', 'PUBLICATION',
  'SUBSCRIPTION', 'STATISTICS', 'ENCODING', 'STDSTRINGS', 'SEARCHPATH', 'DATABASE', 'CAST', 'SERVER',
  'USER MAPPING', 'FOREIGN TABLE', 'TEXT SEARCH CONFIGURATION', 'TEXT SEARCH DICTIONARY', 'ROW SECURITY',
];

interface TocEntry {
  line: string;
  type: string;
  schema: string;
  name: string;
}

/** Parses `215; 1259 16390 TABLE public articles agt_knowledge_base`; comment and blank lines give null. */
export function parseTocLine(line: string): TocEntry | null {
  if (!line.trim() || line.startsWith(';')) return null;
  const match = /^\d+;\s+\d+\s+\d+\s+(.*)$/.exec(line);
  if (!match) return { line, type: '', schema: '', name: '' };
  const rest = match[1];
  const type = tocTypes.find((candidate) => rest === candidate || rest.startsWith(`${candidate} `)) ?? '';
  // What follows the type is "<schema> <name> <owner>"; the owner may be empty.
  const tokens = rest.slice(type.length).trim().split(' ');
  const schema = tokens[0] ?? '';
  const name = tokens.length > 2 ? tokens.slice(1, -1).join(' ') : tokens[1] ?? '';
  return { line, type, schema, name };
}

const publicStructureTypes = new Set(['SEQUENCE', 'SEQUENCE OWNED BY', 'SEQUENCE SET', 'DEFAULT', 'CONSTRAINT', 'FK CONSTRAINT', 'INDEX']);
const allowedTables = new Set<string>([...EXPECTED_TABLES, 'schema_migrations']);

/**
 * Filters `pg_restore --list` output through the BAK-3 allowlist: the `public`
 * schema entry and its comment are removed, entries of the `logs` and `control`
 * schemas are removed with a warning, the expected tables and their data,
 * sequences, defaults, constraints and indexes in `public` are kept, and
 * anything else rejects the archive, naming the entry.
 */

export function allowlistToc(listing: string): { list: string; warnings: string[]; warningCodes: RestoreWarningCode[] } {
  const kept: string[] = [];
  let ignoredLogs = false;
  for (const line of listing.split('\n')) {
    const entry = parseTocLine(line);
    if (!entry) continue;
    const { type, schema, name } = entry;
    if ((type === 'SCHEMA' && schema === '-' && name === 'public') || (type === 'COMMENT' && schema === '-' && name === 'SCHEMA public')) continue;
    if (schema === 'logs' || schema === 'control' || (type === 'SCHEMA' && schema === '-' && (name === 'logs' || name === 'control'))) {
      ignoredLogs = true;
      continue;
    }
    const tableName = name.split(' ')[0];
    const allowed = schema === 'public' && (
      ((type === 'TABLE' || type === 'TABLE DATA') && allowedTables.has(name))
      || (publicStructureTypes.has(type) && tableName !== '')
    );
    if (!allowed) throw new ArchiveRejectedError('disallowed_entry', `The database dump contains an entry that is not allowed: ${line.trim().slice(0, 200)}`);
    kept.push(line);
  }
  const warningCodes: RestoreWarningCode[] = ignoredLogs ? ['log_tables_ignored'] : [];
  return { list: `${kept.join('\n')}\n`, warnings: warningCodes.map((code) => restoreWarnings[code]), warningCodes };
}

// --- The service ------------------------------------------------------------------

interface ValidatedArchive {
  manifest: BackupManifest;
  /** The extracted dump and the allowlisted TOC written next to it. */
  dumpFile: string;
  listFile: string;
  configText: string | null;
  preview: RestorePreview;
}

export interface BackupServiceOptions {
  tools?: ToolRunner;
  now?: () => Date;
  log?: { warn(message: string): void; error(message: string): void; info(message: string): void };
}

type BackupContext = Pick<AppContext, 'config' | 'configFile' | 'db' | 'version' | 'operations' | 'toolPath'>;

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export class BackupService {
  private readonly tools: ToolRunner;
  private readonly now: () => Date;
  private readonly log: NonNullable<BackupServiceOptions['log']>;
  private toolsChecked = false;

  constructor(
    private readonly context: BackupContext,
    private readonly settings: Pick<SettingsService, 'values'> = new SettingsService(context),
    options: BackupServiceOptions = {},
  ) {
    this.tools = options.tools ?? postgresTools(context.db.connection(), context.toolPath);
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? { warn: () => undefined, error: () => undefined, info: () => undefined };
  }

  private get operations(): Operations {
    return this.context.operations;
  }

  /** `storage.backupsDir`, relative to `storage.dataDir`. */
  backupsDirectory() {
    const { storage } = this.context.config;
    return resolve(storage.dataDir, storage.backupsDir);
  }

  /** A fresh temporary directory under `backupsDir` (SEC-10); the caller always deletes it. */
  async temporaryDirectory() {
    const directory = join(this.backupsDirectory(), 'tmp', randomUUID());
    await mkdir(directory, { recursive: true, mode: 0o700 });
    return directory;
  }

  /** BAK-6: the client tools must be at least the server's major version. Checked once per process. */
  private async checkTools(client: Pick<pg.Client, 'query'>) {
    if (this.toolsChecked) return;
    const server = await sqlBackup.serverVersionNumber(client);
    const serverMajor = Math.floor(server / 10_000);
    for (const tool of ['pg_dump', 'pg_restore'] as const) {
      let major: number | null;
      try {
        major = toolMajorVersion((await this.tools(tool, ['--version'], {})).stdout);
      } catch {
        throw new HttpError(500, 'internal', `${tool} is not installed. Install the PostgreSQL ${serverMajor} client tools.`);
      }
      if (major === null || major < serverMajor) {
        throw new HttpError(500, 'internal', `${tool} ${major ?? '(unknown version)'} is older than the PostgreSQL ${serverMajor} server. Install the PostgreSQL ${serverMajor} client tools.`);
      }
    }
    this.toolsChecked = true;
  }

  /** `pg_dump` of the public schema without session rows (BAK-2). */
  private async dump(target: string, signal?: AbortSignal) {
    await this.tools('pg_dump', [
      '--format=custom', '--schema=public', '--no-owner', '--no-privileges',
      ...sessionTables.map((table) => `--exclude-table-data=${table}`),
      `--file=${target}`,
    ], { signal });
  }

  /** Writes a backup archive from a dump file (BAK-2). */
  private async writeArchive(target: string, dumpFile: string, version: number, createdAt: Date) {
    const configText = this.context.configFile.text;
    const files: Array<{ path: string; file?: string; data?: Buffer }> = [{ path: databaseFile, file: dumpFile }];
    if (configText !== null) files.push({ path: configFile, data: Buffer.from(configText, 'utf8') });
    const listed = [];
    for (const file of files) {
      const digest = file.file ? await fileDigest(file.file) : { size: file.data!.length, sha256: createHash('sha256').update(file.data!).digest('hex') };
      listed.push({ path: file.path, size: digest.size, sha256: digest.sha256 });
    }
    const manifest: BackupManifest = {
      format: backupFormat,
      formatVersion: backupFormatVersion,
      appVersion: this.context.version,
      schemaVersion: version,
      createdAt: createdAt.toISOString(),
      files: listed,
    };
    await writeZip(target, [{ path: manifestFile, data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') }, ...files], createdAt);
  }

  /**
   * `GET /api/admin/backup`: takes the backup lock (BAK-8, BAK-12), dumps the
   * database while it holds the write lock (BAK-9), and returns the archive as
   * a stream that deletes its temporary directory when it ends.
   */
  async backup(): Promise<{ filename: string; stream: Readable; size: number }> {
    const directory = await this.temporaryDirectory();
    try {
      const createdAt = this.now();
      const dumpFile = join(directory, databaseFile);
      const version = await this.operations.run('backup', {}, async (run) => {
        const current = await run.control(async (client) => {
          await this.checkTools(client);
          return schemaVersion(client);
        });
        await this.dump(dumpFile, run.signal);
        return current;
      });
      const archive = join(directory, 'backup.zip');
      await this.writeArchive(archive, dumpFile, version, createdAt);
      const { size } = await stat(archive);
      const stream = createReadStream(archive);
      const cleanup = () => void rm(directory, { recursive: true, force: true });
      stream.once('close', cleanup);
      return { filename: backupFileName(createdAt), stream, size };
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  }

  /** `action=preview`: validates the uploaded archive in the preview database (BAK-3). Nothing changes. */
  async preview(upload: string): Promise<RestorePreview> {
    const directory = await this.temporaryDirectory();
    try {
      return (await this.validate(upload, directory)).preview;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * Reads and checks the archive (BAK-2, BAK-3, BAK-7): only the expected
   * paths, the entry and size limits, the manifest and every checksum; a 1.x
   * archive is refused. Then the dump's table of contents through the
   * allowlist, and a restore into the preview database.
   */
  private async validate(upload: string, directory: string): Promise<ValidatedArchive> {
    const limits = await this.settings.values();
    const { size } = await stat(upload);
    if (size > limits['backup.maxZipBytes']) throw new ArchiveRejectedError('too_large', 'The file exceeds the backup size limit.');
    const head = Buffer.alloc(4);
    const handle = await open(upload, 'r');
    try {
      await handle.read(head, 0, 4, 0);
    } finally {
      await handle.close();
    }
    if (head.toString('latin1') !== 'PK\u0003\u0004') throw new ArchiveRejectedError('not_zip', 'The file is not a ZIP archive.');

    let entries: ExtractedEntry[];
    try {
      entries = await extractZip(upload, directory, (path) => [manifestFile, databaseFile, configFile, legacyDatabaseFile].includes(path), {
        maxEntries: limits['backup.maxEntries'],
        maxUncompressedBytes: limits['backup.maxUncompressedBytes'],
      });
    } catch (error) {
      if (error instanceof ZipRejectedError) throw new ArchiveRejectedError('unsafe_zip', error.message);
      throw error;
    }
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));
    const manifestEntry = byPath.get(manifestFile);
    if (!manifestEntry) throw new ArchiveRejectedError('missing_manifest', `The archive has no ${manifestFile}.`);
    if (manifestEntry.size > 1024 * 1024) throw new ArchiveRejectedError('invalid_manifest', `${manifestFile} is too large.`);
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(manifestEntry.file, 'utf8'));
    } catch {
      throw new ArchiveRejectedError('invalid_manifest', `${manifestFile} is not valid JSON.`);
    }
    const manifestObject = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
    // A 1.x archive: database.json, or a manifest with `migrations` or a `files` object.
    if (byPath.has(legacyDatabaseFile) || 'migrations' in manifestObject
      || (manifestObject.files !== undefined && typeof manifestObject.files === 'object' && !Array.isArray(manifestObject.files))) {
      throw new ArchiveRejectedError('legacy_format', legacyArchiveMessage);
    }
    if (manifestObject.format !== undefined && manifestObject.format !== backupFormat) {
      throw new ArchiveRejectedError('not_a_backup', 'The archive is not an AGT Knowledge Base backup.');
    }
    if (typeof manifestObject.formatVersion === 'number' && manifestObject.formatVersion > backupFormatVersion) {
      throw new ArchiveRejectedError('newer_format', `The backup has format version ${manifestObject.formatVersion}; this version of AGT Knowledge Base restores up to ${backupFormatVersion}. Upgrade first.`);
    }
    const parsed = manifestSchema.safeParse(raw);
    if (!parsed.success) throw new ArchiveRejectedError('invalid_manifest', `${manifestFile} is invalid (${parsed.error.issues[0].path.join('.') || 'root'}).`);
    const manifest = parsed.data;
    const listed = new Map(manifest.files.map((file) => [file.path, file]));
    if (listed.size !== manifest.files.length) throw new ArchiveRejectedError('invalid_manifest', 'The manifest lists a file more than once.');
    for (const entry of entries) {
      if (entry.path === manifestFile) continue;
      const expected = listed.get(entry.path);
      if (!expected) throw new ArchiveRejectedError('unlisted_file', `${entry.path} is not listed in the manifest.`);
      if (expected.size !== entry.size || expected.sha256 !== entry.sha256) {
        throw new ArchiveRejectedError('checksum_mismatch', `The checksum of ${entry.path} does not match the manifest.`);
      }
    }
    for (const path of listed.keys()) {
      if (!byPath.has(path)) throw new ArchiveRejectedError('missing_file', `The manifest lists ${path}, which the archive does not contain.`);
    }
    const dumpEntry = byPath.get(databaseFile);
    if (!dumpEntry) throw new ArchiveRejectedError('missing_file', `The archive has no ${databaseFile}.`);
    const latest = MIGRATIONS.at(-1)!.version;
    if (manifest.schemaVersion > latest) {
      throw new ArchiveRejectedError('newer_schema', `The backup's database schema (version ${manifest.schemaVersion}) is newer than this version of AGT Knowledge Base supports (${latest}). Upgrade first.`);
    }
    const configEntry = byPath.get(configFile);
    const configText = configEntry ? await readFile(configEntry.file, 'utf8') : null;
    const dumpFile = join(directory, databaseFile);
    await rename(dumpEntry.file, dumpFile);

    const { list, warningCodes } = await this.allowlist(dumpFile);
    const listFile = join(directory, 'database.list');
    await writeFile(listFile, list, { mode: 0o600 });
    const checked = await this.checkInPreviewDatabase(dumpFile, listFile);
    if (checked.schemaVersion !== manifest.schemaVersion) {
      throw new ArchiveRejectedError('schema_mismatch', `The dump's schema version (${checked.schemaVersion}) does not match the manifest (${manifest.schemaVersion}).`);
    }

    const currentConfig = this.context.configFile.text;
    const backupIds = MIGRATIONS.filter((migration) => migration.version <= checked.schemaVersion).map(migrationId);
    const preview: RestorePreview = {
      createdAt: manifest.createdAt,
      appVersion: manifest.appVersion,
      formatVersion: manifest.formatVersion,
      schemaVersion: { backup: checked.schemaVersion, current: latest },
      migrations: {
        backup: backupIds,
        upgrade: MIGRATIONS.filter((migration) => migration.version > checked.schemaVersion).map(migrationId),
      },
      counts: checked.counts,
      config: {
        included: configText !== null,
        content: configText,
        diff: configText !== null && currentConfig !== null ? diffLines(currentConfig, configText) : null,
        identical: configText !== null && configText === currentConfig,
      },
      ignoredSettings: checked.ignoredSettings,
      warnings: [...warningCodes, ...checked.warningCodes].map((code) => restoreWarnings[code]),
      warningCodes: [...warningCodes, ...checked.warningCodes],
    };
    return { manifest, dumpFile, listFile, configText, preview };
  }

  /** `pg_restore --list` through the allowlist (BAK-3). */
  private async allowlist(dumpFile: string) {
    let listing: string;
    try {
      listing = (await this.tools('pg_restore', ['--list', dumpFile], {})).stdout;
    } catch (error) {
      this.log.warn(`pg_restore --list rejected an uploaded dump: ${message(error)}`);
      throw new ArchiveRejectedError('invalid_dump', `${databaseFile} is not a valid PostgreSQL custom-format dump.`);
    }
    return allowlistToc(listing);
  }

  /**
   * BAK-3, Postgres preview: under the preview lock, empties the preview
   * database, restores the dump there with the allowlisted list, checks the
   * schema version, the expected tables and the Admin's password hash, counts
   * the rows, and empties the database again.
   */
  private async checkInPreviewDatabase(dumpFile: string, listFile: string) {
    const pool = await this.context.db.pool();
    const lockClient = await pool.connect();
    let locked = false;
    try {
      locked = await tryAdvisoryLock(lockClient, 'preview');
      if (!locked) throw new HttpError(409, 'conflict', 'Another restore preview is running. Try again in a moment.');
      await this.checkTools(lockClient);
      const previewName = this.context.config.database.previewName;
      const preview = await this.previewClient();
      try {
        await sqlBackup.emptyPublicSchema(preview);
        try {
          await this.tools('pg_restore', [
            `--dbname=${previewName}`, '--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction', `--use-list=${listFile}`, dumpFile,
          ], { timeoutMilliseconds: restoreTimeoutMilliseconds });
        } catch (error) {
          this.log.warn(`An uploaded dump could not be restored into the preview database: ${message(error)}`);
          throw new ArchiveRejectedError('invalid_dump', `${databaseFile} could not be restored. It is damaged or was not made by AGT Knowledge Base.`);
        }
        return await inspectRestored(preview, lockedSettingKeys(this.context.config));
      } finally {
        await sqlBackup.emptyPublicSchema(preview).catch((error: unknown) => this.log.error(`The preview database could not be emptied: ${message(error)}`));
        await preview.end().catch(() => undefined);
      }
    } finally {
      if (locked) await advisoryUnlock(lockClient, 'preview').catch(() => undefined);
      lockClient.release();
    }
  }

  private async previewClient() {
    const name = this.context.config.database.previewName;
    const client = this.context.db.client(name);
    client.on('error', () => undefined);
    try {
      await client.connect();
    } catch (error) {
      await client.end().catch(() => undefined);
      throw new HttpError(500, 'internal', `The preview database ${name} cannot be opened (${message(error)}). Create it, owned by the app role (README, Backups).`);
    }
    return client;
  }

  /**
   * At startup: empties the preview database after a preview cut short by a
   * crash, only while holding the preview lock (BAK-3). Another process's
   * preview empties it in its own `finally`.
   */
  async cleanPreviewDatabase() {
    const pool = await this.context.db.pool();
    const client = await pool.connect();
    try {
      if (!await tryAdvisoryLock(client, 'preview')) return;
      try {
        const preview = await this.previewClient();
        try {
          await sqlBackup.emptyPublicSchema(preview);
        } finally {
          await preview.end().catch(() => undefined);
        }
      } finally {
        await advisoryUnlock(client, 'preview');
      }
    } catch (error) {
      this.log.warn(message(error));
    } finally {
      client.release();
    }
  }

  /**
   * `action=restore` (BAK-4): validates the upload again (step 1), takes the
   * restore lock in every process (step 2), writes the pre-restore backup and
   * its rollback list (step 3), replaces the database (step 4), migrates and
   * checks it (step 5), then commits the session and locked-settings cleanup
   * (step 6.1). A failure in steps 4–6.1 rolls back (BAK-10); a failed
   * rollback leaves the app in `restore_failed` (BAK-11). A recovery restore
   * starts from `restore_failed`, skips step 3 and has nothing to roll back to.
   */
  async restore(upload: string, session: RecoverySession, recovery = false): Promise<RestoreReport> {
    const directory = await this.temporaryDirectory();
    try {
      const archive = await this.validate(upload, directory);
      const locked = lockedSettingKeys(this.context.config);
      return await this.operations.run('restore', { session, recovery }, async (run) => {
        let preRestore: { name: string; dumpFile: string; listFile: string } | null = null;
        if (!recovery) {
          preRestore = await this.writePreRestoreBackup(run, directory);
          await run.setPreRestoreBackup(preRestore.name);
        }
        try {
          await this.replaceDatabase(run, archive.dumpFile, archive.listFile);
          await this.migrateAndCheck(run);
          await run.control((client) => sqlBackup.commitRestore(client, locked, sessionTables));
        } catch (error) {
          this.log.error(`The restore failed: ${message(error)}`);
          if (recovery || !preRestore) {
            run.fail(run.preRestoreBackup);
            throw new HttpError(500, 'internal', 'The restore failed. The app stays in maintenance.');
          }
          await this.rollBack(run, preRestore);
          throw new HttpError(500, 'internal', 'The restore failed and was rolled back. Nothing was changed.');
        }
        this.log.info(`Restored a backup created ${archive.manifest.createdAt}.`);
        return { ...archive.preview, preRestoreBackup: preRestore?.name ?? null };
      });
    } finally {
      await rm(directory, { recursive: true, force: true }).catch((error: unknown) => {
        this.log.warn(`The temporary restore directory ${directory} could not be deleted: ${message(error)}`);
      });
    }
  }

  /**
   * BAK-4 step 3: the current data as a backup archive in `backupsDir`, kept,
   * and its own allowlisted table of contents as the rollback list. Nothing
   * has changed if this fails.
   */
  private async writePreRestoreBackup(run: OperationRun, directory: string) {
    const backups = this.backupsDirectory();
    const createdAt = this.now();
    const name = `pre-restore-backup-${fileTimestamp(createdAt)}.zip`;
    const dumpFile = join(directory, 'pre-restore.dump');
    const listFile = join(backups, name.replace(/\.zip$/, '.list'));
    try {
      const version = await run.control(async (client) => {
        await this.checkTools(client);
        return schemaVersion(client);
      });
      await this.dump(dumpFile, run.signal);
      const { list } = allowlistToc((await this.tools('pg_restore', ['--list', dumpFile], { signal: run.signal })).stdout);
      await mkdir(backups, { recursive: true });
      await this.writeArchive(join(backups, name), dumpFile, version, createdAt);
      await writeFile(listFile, list, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      this.log.error(`The pre-restore backup failed: ${message(error)}`);
      await rm(join(backups, name), { force: true });
      await rm(listFile, { force: true });
      throw new HttpError(500, 'internal', 'The pre-restore backup could not be written, so nothing was restored. Check storage.backupsDir.');
    }
    await this.prunePreRestoreBackups(backups, name);
    return { name, dumpFile, listFile };
  }

  /** `backup.preRestore.keep`: deletes the oldest pre-restore backups beyond it, each with its `.list`; never `current`. */
  async prunePreRestoreBackups(directory: string, current: string) {
    const keep = this.context.config.backup.preRestore.keep;
    if (keep === undefined) return;
    const files = (await readdir(directory)).filter((name) => preRestorePattern.test(name)).sort();
    const excess = files.filter((name) => name !== current).slice(0, Math.max(0, files.length - keep));
    for (const name of excess) {
      await rm(join(directory, name), { force: true });
      await rm(join(directory, name.replace(/\.zip$/, '.list')), { force: true });
    }
  }

  /** BAK-4 step 4: closes the pool, replaces the database in one transaction, and lets the next use create a new pool. */
  private async replaceDatabase(run: OperationRun, dumpFile: string, listFile: string) {
    await this.context.db.close();
    await this.tools('pg_restore', [
      `--dbname=${this.context.db.connection().database}`, '--clean', '--if-exists', '--single-transaction',
      '--no-owner', '--no-privileges', '--exit-on-error', `--use-list=${listFile}`, dumpFile,
    ], { signal: run.signal, timeoutMilliseconds: restoreTimeoutMilliseconds });
  }

  /** BAK-4 step 5: pending migrations, then the health check on the new pool. */
  private async migrateAndCheck(run: OperationRun) {
    await run.control((client) => applyAppMigrations(client, { info: (text) => this.log.info(text) }));
    await ping(this.context.db);
    const pool = await this.context.db.pool();
    const version = await schemaVersion(pool);
    if (version !== MIGRATIONS.at(-1)!.version) throw new Error(`The restored schema version is ${version}.`);
    const tables = await sqlBackup.publicTables(pool);
    const missing = EXPECTED_TABLES.filter((table) => !tables.has(table));
    if (missing.length) throw new Error(`The restored database lacks ${missing.join(', ')}.`);
  }

  /** BAK-10: restores the pre-restore dump with its own rollback list and checks it; a failure ends in `restore_failed` (BAK-11). */
  private async rollBack(run: OperationRun, preRestore: { name: string; dumpFile: string; listFile: string }) {
    try {
      await this.replaceDatabase(run, preRestore.dumpFile, preRestore.listFile);
      await this.migrateAndCheck(run);
      this.log.error(`The restore was rolled back to ${preRestore.name}.`);
    } catch (error) {
      this.log.error(`The rollback failed: ${message(error)}. Restore ${preRestore.name} by hand (README, Recovering from a failed restore).`);
      run.fail(preRestore.name);
      throw new HttpError(500, 'internal', `The restore failed and could not be rolled back. The app stays in maintenance; restore ${preRestore.name} as the README describes.`);
    }
  }
}

/** BAK-3 step 4: the checks on the dump restored into the preview database. */
async function inspectRestored(client: Pick<pg.Client, 'query'>, locked: string[]) {
  const tables = await sqlBackup.publicTables(client);
  if (!tables.has('schema_migrations')) throw new ArchiveRejectedError('missing_tables', 'The dump has no schema_migrations table.');
  const version = await schemaVersion(client);
  const missing = EXPECTED_TABLES.filter((table) => !tables.has(table));
  if (missing.length) throw new ArchiveRejectedError('missing_tables', `The dump lacks the tables ${missing.join(', ')}.`);
  const counts: Record<string, number> = {};
  for (const table of EXPECTED_TABLES) {
    if (!sessionTables.includes(table as typeof sessionTables[number])) counts[table] = await sqlBackup.rowCount(client, table);
  }
  const admins = await sqlBackup.adminPasswordHashes(client);
  if (admins.length > 1) throw new ArchiveRejectedError('invalid_admin', 'The backup contains more than one Admin account.');
  if (admins.length === 1 && !parseHash(admins[0])) {
    throw new ArchiveRejectedError('invalid_admin', 'The Admin password hash in the backup is malformed or uses unsupported parameters, so it could never sign in.');
  }
  const warningCodes: RestoreWarningCode[] = admins.length === 0 ? ['no_admin'] : [];
  return { schemaVersion: version, counts, ignoredSettings: await sqlBackup.storedSettingKeys(client, locked), warningCodes };
}
