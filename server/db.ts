import { AsyncLocalStorage } from 'node:async_hooks';
import { existsSync } from 'node:fs';
import pg from 'pg';
import m0001 from './migrations/0001_initial.sql';
import m0002 from './migrations/0002_article_revisions.sql';
import m0003 from './migrations/0003_article_pinning.sql';
import m0004 from './migrations/0004_article_visibility.sql';
import m0005 from './migrations/0005_article_verification.sql';
import m0006 from './migrations/0006_canonical_tags_expand.sql';
import m0007 from './migrations/0007_canonical_tags_contract.sql';
import m0008 from './migrations/0008_local_auth.sql';
import m0009 from './migrations/0009_admin.sql';
import m0010 from './migrations/0010_agt_visibility.sql';
import m0011 from './migrations/0011_rename_user_key.sql';
import m0012 from './migrations/0012_admin_account.sql';
import m0013 from './migrations/0013_backup_limit_settings.sql';
import m0014 from './migrations/0014_admin_account_contract.sql';
import m0015 from './migrations/0015_settings_table.sql';
import m0016 from './migrations/0016_drop_application_settings.sql';
import m0017 from './migrations/0017_auth_sessions.sql';
import m0018 from './migrations/0018_spec_storage.sql';

import c0001 from './migrations/control/0001_operation.sql';

const { Pool, Client } = pg;

/** How to reach PostgreSQL. `databaseSettings()` in `server/startup.ts` builds it; a connection string only from the deprecated DATABASE_URL. */
export type DatabaseSettings =
  | { connectionString: string; ssl: boolean }
  | { host: string; port: number; database: string; user: string; password: string; ssl: boolean };

/** The parts of the connection settings, for `pg.Client` and the `pg_dump`/`pg_restore` children (BAK-6). */
export interface ConnectionParameters {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  ssl: boolean;
}

/** Splits the deprecated DATABASE_URL into its parts, so a password never has to go on a command line (BAK-6). */
export function connectionParameters(settings: DatabaseSettings): ConnectionParameters {
  if (!('connectionString' in settings)) return { ...settings };
  const url = new URL(settings.connectionString);
  const decode = (value: string) => decodeURIComponent(value);
  return {
    host: decode(url.hostname) || 'localhost',
    port: url.port ? Number(url.port) : 5432,
    database: decode(url.pathname.replace(/^\//, '')),
    user: decode(url.username),
    password: decode(url.password),
    ssl: settings.ssl,
  };
}

/**
 * The app's database handle. Services ask it for the pool on every use, so a
 * restore can close the pool and the next use creates a new one (SRV-3, BAK-4).
 * Inside `withDataWrite()` the pool it returns runs every statement on the
 * write's own client (BAK-12).
 */
export interface Database {
  pool(): Promise<pg.Pool>;
  /** Ends the pool; the next `pool()` call creates a new one. */
  close(): Promise<void>;
  /** The connection settings, for the control connection and the backup tools. */
  connection(): ConnectionParameters;
  /** A new client outside the pool (the BAK-12 control connection, the preview database); the caller connects and ends it. */
  client(database?: string): pg.Client;
}

const poolOptions = { max: 5, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 };

/** What `withDataWrite()` marks its call with: the client its transaction runs on, if any (BAK-8). */
export interface DataWriteScope {
  client?: pg.PoolClient;
}

/** The data write the current call runs in, if any (BAK-8). Only `server/dataWrite.ts` enters it. */
export const dataWriteScope = new AsyncLocalStorage<DataWriteScope>();

/**
 * A pool stand-in that runs everything on one client inside an open
 * transaction: a repository's own BEGIN, COMMIT and ROLLBACK become a
 * savepoint, its release, and a rollback to it, so the data write commits or
 * rolls back as one transaction.
 */
function scopedPool(client: pg.PoolClient): pg.Pool {
  let depth = 0;
  const query = (async (text: unknown, ...rest: unknown[]) => {
    const statement = typeof text === 'string' ? text.trim().toUpperCase() : '';
    if (statement === 'BEGIN') {
      depth += 1;
      return client.query(`SAVEPOINT data_write_${depth}`);
    }
    if (statement === 'COMMIT' && depth > 0) {
      const name = `data_write_${depth}`;
      depth -= 1;
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    if (statement === 'ROLLBACK' && depth > 0) {
      const name = `data_write_${depth}`;
      depth -= 1;
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      return client.query(`RELEASE SAVEPOINT ${name}`);
    }
    return (client.query as (...args: unknown[]) => unknown)(text, ...rest);
  }) as pg.PoolClient['query'];
  const scoped = { query, release: () => undefined } as unknown as pg.PoolClient;
  return { query, connect: async () => scoped } as unknown as pg.Pool;
}

/** A database backed by one `pg.Pool`, created lazily on first use (DATA-11). */
export function createDatabase(settings: DatabaseSettings): Database {
  let pool: pg.Pool | undefined;
  const parameters = connectionParameters(settings);
  const ssl = settings.ssl ? { rejectUnauthorized: true } : false;
  return {
    async pool() {
      const scope = dataWriteScope.getStore();
      if (scope?.client) return scopedPool(scope.client);
      pool ??= new Pool({ ...settings, ssl, ...poolOptions });
      return pool;
    },
    async close() {
      const current = pool;
      pool = undefined;
      await current?.end();
    },
    connection: () => ({ ...parameters }),
    client: (database = parameters.database) => new Client({ ...parameters, database, ssl }),
  };
}

interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[]; rowCount: number | null }>;
}

/** Runs `work` in one transaction on one pool client, and always releases the client (DATA-11). */
export async function withTransaction<T>(pool: pg.Pool, work: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch((rollbackError: unknown) => {
      broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
    });
    throw error;
  } finally {
    // A client whose rollback failed is destroyed rather than returned to the pool.
    client.release(broken);
  }
}

export interface Migration {
  /** `NNNN` of `server/migrations/NNNN_<name>.sql`. */
  version: number;
  name: string;
  sql: string;
}

/**
 * Every schema change, in order (DATA-3). Never edit or reorder a released
 * migration; add a new file and append it here.
 */
export const MIGRATIONS: readonly Migration[] = [
  [m0001, 'initial'],
  [m0002, 'article_revisions'],
  [m0003, 'article_pinning'],
  [m0004, 'article_visibility'],
  [m0005, 'article_verification'],
  [m0006, 'canonical_tags_expand'],
  [m0007, 'canonical_tags_contract'],
  [m0008, 'local_auth'],
  [m0009, 'admin'],
  [m0010, 'agt_visibility'],
  [m0011, 'rename_user_key'],
  [m0012, 'admin_account'],
  [m0013, 'backup_limit_settings'],
  [m0014, 'admin_account_contract'],
  [m0015, 'settings_table'],
  [m0016, 'drop_application_settings'],
  [m0017, 'auth_sessions'],
  [m0018, 'spec_storage'],
].map(([sql, name], index) => ({ version: index + 1, name, sql }));

/** The 1.x name of a migration (`001_initial`), still reported in the deprecated `migrations` field of a restore preview. */
export function migrationId(migration: Pick<Migration, 'version' | 'name'>) {
  return `${String(migration.version).padStart(3, '0')}_${migration.name}`;
}

/**
 * The migrations of the BAK-12 `control` schema, recorded in
 * `control.schema_migrations`. A restore replaces the app's schema but never
 * this one, so they are numbered separately.
 */
export const CONTROL_MIGRATIONS: readonly Migration[] = [
  [c0001, 'operation'],
].map(([sql, name], index) => ({ version: index + 1, name, sql }));

export class StartupCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupCheckError';
  }
}

/** `(0, hashtext('agt_knowledge_base_<name>'))`, the BAK-12 advisory lock keys. */
export function lockKey(name: 'migrations' | 'operation' | 'activity' | 'writes' | 'preview') {
  return `(0, hashtext('agt_knowledge_base_${name}'))`;
}

const migrationLock = `SELECT pg_advisory_lock${lockKey('migrations')}`;
const migrationUnlock = `SELECT pg_advisory_unlock${lockKey('migrations')}`;

const versionTableColumns = `version integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()`;

/** Turns the 1.x `schema_migrations (id text, applied_at)` into the DATA-11 `(version, name, applied_at)` table. */
async function prepareVersionTable(client: Pick<Queryable, 'query'>) {
  const columns = (await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'schema_migrations'`,
  )).rows.map((row) => (row as { column_name: string }).column_name);
  if (!columns.length) {
    await client.query(`CREATE TABLE schema_migrations (
      ${versionTableColumns}
    )`);
    return;
  }
  if (!columns.includes('id')) return;
  await client.query('BEGIN');
  try {
    await client.query(`CREATE TABLE schema_migrations_v2 (
      ${versionTableColumns}
    )`);
    await client.query(`INSERT INTO schema_migrations_v2 (version, name, applied_at)
      SELECT split_part(id, '_', 1)::integer, substr(id, strpos(id, '_') + 1), applied_at FROM schema_migrations`);
    await client.query('DROP TABLE schema_migrations');
    await client.query('ALTER TABLE schema_migrations_v2 RENAME TO schema_migrations');
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

/** The applied versions, oldest first. */
export async function appliedVersions(client: Pick<Queryable, 'query'>, table = 'schema_migrations'): Promise<number[]> {
  const result = await client.query(`SELECT version FROM ${table} ORDER BY version`);
  return result.rows.map((row) => Number((row as { version: number }).version));
}

/** Applies the pending migrations of one list, each in its own transaction; a newer schema stops the server (SRV-8). */
async function applyPending(
  client: Pick<Queryable, 'query'>,
  migrations: readonly Migration[],
  table: string,
  describe: string,
  log: { info(message: string): void },
) {
  const done = new Set(await appliedVersions(client, table));
  const latest = migrations.at(-1)!.version;
  const unknown = [...done].filter((version) => !migrations.some((migration) => migration.version === version));
  if (unknown.length) {
    throw new StartupCheckError(`The ${describe} is newer than this version of AGT Knowledge Base supports (migration ${Math.max(...unknown)}; this version knows up to ${latest}). Install a newer version.`);
  }
  const applied: number[] = [];
  for (const migration of migrations) {
    if (done.has(migration.version)) continue;
    await client.query('BEGIN');
    try {
      await client.query(migration.sql);
      await client.query(`INSERT INTO ${table} (version, name) VALUES ($1, $2)`, [migration.version, migration.name]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
    applied.push(migration.version);
    log.info(`Applied ${table === 'schema_migrations' ? '' : 'control '}migration ${String(migration.version).padStart(4, '0')}_${migration.name}.`);
  }
  return applied;
}

/** Applies the app's pending migrations (DATA-4). The caller holds the write lock: at startup shared, in a restore exclusive (BAK-12). */
export async function applyAppMigrations(client: Pick<Queryable, 'query'>, log: { info(message: string): void } = { info: () => undefined }) {
  await prepareVersionTable(client);
  return applyPending(client, MIGRATIONS, 'schema_migrations', 'database schema', log);
}

/** The schema version (DATA-4): the highest applied app migration, or 0. */
export async function schemaVersion(client: Pick<Queryable, 'query'>) {
  return Math.max(0, ...await appliedVersions(client));
}

export interface StartupOptions {
  log?: { info(message: string): void };
  /** `<dataDir>/restore-failed.json`, the BAK-11 marker file. */
  restoreFailedMarker?: string;
  /** Waits between attempts while a backup or restore runs (tests pass a fast one). */
  sleep?: (milliseconds: number) => Promise<void>;
}

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * The BAK-12 startup steps, on the process's control connection, before it
 * listens: refuse a superuser role (DATA-11); take the migration lock; set up
 * and migrate the `control` schema; refuse to start after a failed restore
 * (BAK-11); apply the app's migrations while holding the write lock shared
 * with the operation state `idle`, so they never run during a backup or
 * restore; release the migration lock. A newer schema stops the server (SRV-8).
 */
export async function migrateAtStartup(client: Pick<Queryable, 'query'>, options: StartupOptions = {}) {
  const log = options.log ?? { info: () => undefined };
  const sleep = options.sleep ?? wait;
  const superuser = await client.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
  if ((superuser.rows[0] as { rolsuper?: boolean } | undefined)?.rolsuper) {
    throw new StartupCheckError('The database role is a superuser. Connect as the agt_knowledge_base role (database.user); see deploy/upgrade-database-role.sql to create it.');
  }
  await client.query(migrationLock);
  try {
    await client.query('CREATE SCHEMA IF NOT EXISTS control');
    await client.query(`CREATE TABLE IF NOT EXISTS control.schema_migrations (
      ${versionTableColumns}
    )`);
    await applyPending(client, CONTROL_MIGRATIONS, 'control.schema_migrations', 'control schema', log);
    await refuseAfterFailedRestore(client, options.restoreFailedMarker);
    for (;;) {
      await client.query(`SELECT pg_advisory_lock_shared${lockKey('writes')}`);
      try {
        const state = (await client.query('SELECT state FROM control.operation WHERE id = 1')).rows[0] as { state: string } | undefined;
        if (state?.state === 'idle') return { applied: await applyAppMigrations(client, log) };
      } finally {
        await client.query(`SELECT pg_advisory_unlock_shared${lockKey('writes')}`);
      }
      await sleep(1000);
    }
  } finally {
    await client.query(migrationUnlock).catch(() => undefined);
  }
}

/** The README section on recovering from a failed restore (BAK-11). */
const recoveryHelp = 'See "Recovering from a failed restore" in README.md.';

/** BAK-11: refuse to start while the marker file exists or the shared state is `restore_failed`, naming what is missing. */
async function refuseAfterFailedRestore(client: Pick<Queryable, 'query'>, marker: string | undefined) {
  const row = (await client.query('SELECT state, pre_restore_backup FROM control.operation WHERE id = 1')).rows[0] as
    { state: string; pre_restore_backup: string | null } | undefined;
  const failedState = row?.state === 'restore_failed';
  const markerExists = marker !== undefined && existsSync(marker);
  if (!failedState && !markerExists) return;
  const backup = row?.pre_restore_backup ? `the pre-restore backup ${row.pre_restore_backup}` : 'the pre-restore backup named in the marker file';
  if (failedState && markerExists) {
    throw new StartupCheckError(`A restore failed and could not be rolled back. Restore ${backup} by hand, then clear the failed state. ${recoveryHelp}`);
  }
  if (failedState) {
    throw new StartupCheckError(`The database records a failed restore (control.operation is restore_failed), but the marker file ${marker ?? 'restore-failed.json'} is missing. Restore ${backup} by hand, then clear the failed state. ${recoveryHelp}`);
  }
  throw new StartupCheckError(`The marker file ${marker} records a failed restore, but control.operation is not restore_failed. Check that the data directory and database belong together, restore the data by hand, then delete the marker file. ${recoveryHelp}`);
}

/**
 * The startup steps on a pool client instead of a control connection, for
 * scripts and tests: see `migrateAtStartup()`.
 */
export async function runMigrations(db: Pick<Database, 'pool'>, options: StartupOptions | { info(message: string): void } = {}) {
  const startup = 'info' in options ? { log: options } : options;
  const pool = await db.pool();
  const client = await pool.connect();
  try {
    return await migrateAtStartup(client, startup);
  } finally {
    client.release();
  }
}
