import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type pg from 'pg';
import {
  buildBackupArchive,
  invalidBackup,
  readBackupArchive,
  type BackupContents,
  type BackupRow,
} from './backup-archive.js';
import { lockedSettingKeys, type AppContext } from './context.js';
import { HttpError } from './http.js';
import { diffLines, type DiffLine } from './line-diff.js';
import { migrations as knownMigrations } from './migrations.js';
import { migrationsById } from './migrations-runner.js';
import { SettingsService } from './settings-service.js';


/**
 * Every application table, in an order that satisfies foreign keys on insert.
 * `schema_migrations` is recorded in the manifest instead. Sessions (`sessions`,
 * `member_sessions`) are never backed up and are cleared by every restore.
 */
export const backupTables = [
  'app_users',
  'local_users',
  'tags',
  'articles',
  'article_revisions',
  'settings',
  'admin',
] as const;

/** Tables the migrations create that backups deliberately leave out. */
export const unbackedTables = ['sessions', 'member_sessions'] as const;

/** Earlier names of unbacked tables, which a backup's schema version may still have (017 renamed `admin_sessions`). */
const formerUnbackedTables = ['admin_sessions'];

/**
 * Tables that exist only until a contract migration drops them. They are
 * exported while they exist, so a backup matches its schema version, but a
 * restore never writes them: their data has already moved.
 */
export const legacyTables = ['application_settings'] as const;

export type BackupTable = typeof backupTables[number];
export type BackupCounts = Record<string, number>;

export interface RestorePreview {
  createdAt: string;
  appVersion: string;
  /** Migrations the backup was taken at, and those the restore applies to bring it up to date. */
  migrations: { backup: string[]; upgrade: string[] };
  counts: BackupCounts;
  config: {
    /** Whether the backup contains a config.yaml. It is never restored. */
    included: boolean;
    content: string | null;
    /** Line diff from the current file to the backup's, or null when either is missing or too long. */
    diff: DiffLine[] | null;
    identical: boolean;
  };
  /** Settings in the backup that config.yaml now defines; they are not restored. */
  ignoredSettings: string[];
}

export interface RestoreReport extends RestorePreview {
  /** The pre-restore backup of the replaced data, in `storage.backupsDir`. */
  preRestoreBackup: string;
}

interface ColumnRow {
  table_name: string;
  column_name: string;
  is_generated: string;
}

interface TableColumns {
  stored: string[];
  generated: string[];
}

interface DatabaseError {
  code: string;
  table?: string;
  constraint?: string;
}

/** Serializes concurrent previews and restores. */
const restoreLockKey = 4_207_421;
const preRestorePattern = /^pre-restore-backup-\d{8}-\d{6}-\d{3}(-[0-9a-f]{6})?\.zip$/;

function quoteIdentifier(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}

function qualified(schema: string, table: string) {
  return `${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
}

function stamp(date: Date, milliseconds = false) {
  const iso = date.toISOString();
  const base = iso.slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  return milliseconds ? `${base}-${iso.slice(20, 23)}` : base;
}

function sameMembers(left: string[], right: string[]) {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

/** Postgres data exceptions (22xxx) and integrity violations (23xxx) mean the backup content is invalid. */
function isDataError(error: unknown): error is DatabaseError {
  return typeof error === 'object' && error !== null && 'code' in error
    && typeof error.code === 'string' && /^2[23]/.test(error.code);
}

/** Describes a rejected row without echoing database messages, which can contain row values. */
function describeDataError(error: DatabaseError) {
  if (error.code.startsWith('22')) return 'it contains a value with the wrong type or format.';
  const table = error.table ? `a row in ${error.table}` : 'a row';
  return error.constraint ? `${table} violates the ${error.constraint} constraint.` : `${table} violates a database constraint.`;
}

async function appliedMigrations(client: pg.PoolClient) {
  const result = await client.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id');
  return result.rows.map((row) => row.id);
}

/** Stored and generated column names of every base table in a schema (optionally only `tables`). */
async function schemaColumns(client: pg.PoolClient, schema: string, tables?: readonly string[]) {
  const result = await client.query<ColumnRow>(
    `SELECT c.table_name, c.column_name, c.is_generated
     FROM information_schema.columns c
     JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE'
       AND ($2::text[] IS NULL OR c.table_name = ANY($2::text[]))
     ORDER BY c.table_name, c.ordinal_position`,
    [schema, tables ?? null],
  );
  const columns = new Map<string, TableColumns>();
  for (const row of result.rows) {
    const entry = columns.get(row.table_name) ?? { stored: [], generated: [] };
    (row.is_generated === 'ALWAYS' ? entry.generated : entry.stored).push(row.column_name);
    columns.set(row.table_name, entry);
  }
  return columns;
}

/**
 * The backup's migrations must be exactly the start of this installation's
 * applied list. Anything else (newer, unknown, or diverging) is refused.
 */
export function upgradePlan(backupMigrations: string[], current: string[]) {
  const unknown = backupMigrations.find((id) => !knownMigrations.some((migration) => migration.id === id));
  if (unknown) invalidBackup(`it was created by a newer or different version of the application (unknown migration ${unknown}).`);
  if (backupMigrations.length > current.length) {
    invalidBackup('it was created by a newer version of the application. Upgrade this installation first.');
  }
  const diverges = backupMigrations.findIndex((id, index) => current[index] !== id);
  if (diverges >= 0) {
    invalidBackup(`its schema history diverges from this installation's at ${backupMigrations[diverges]}.`);
  }
  return current.slice(backupMigrations.length);
}

export class BackupService {
  constructor(
    private readonly context: Pick<AppContext, 'config' | 'configFile' | 'db' | 'version'>,
    private readonly settings = new SettingsService(context),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Exports every application table from one consistent snapshot as a ZIP archive. */
  async export(): Promise<{ filename: string; archive: Buffer }> {
    const pool = await this.context.db.pool();
    const client = await pool.connect();
    let migrations: string[];
    const tables: Record<string, BackupRow[]> = {};
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      migrations = await appliedMigrations(client);
      const schema = (await client.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0].schema;
      const columns = await schemaColumns(client, schema, [...backupTables, ...legacyTables]);
      for (const table of [...backupTables, ...legacyTables]) {
        const entry = columns.get(table);
        if (!entry && (legacyTables as readonly string[]).includes(table)) continue;
        if (!entry) throw new Error(`The ${table} table is missing.`);
        const result = await client.query<{ rows: BackupRow[] }>(
          `SELECT coalesce(jsonb_agg(to_jsonb(source) - $1::text[]), '[]'::jsonb) AS rows
           FROM ${qualified(schema, table)} source`,
          [entry.generated],
        );
        tables[table] = result.rows[0]?.rows ?? [];
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const createdAt = this.now();
    const archive = await buildBackupArchive({
      appVersion: this.context.version,
      createdAt: createdAt.toISOString(),
      migrations,
      database: { tables },
      configText: this.context.configFile.text,
    });
    return { filename: `agt-kb-backup-${stamp(createdAt)}.zip`, archive };
  }

  /** Validates an archive and reports what a restore would do. Nothing changes. */
  async preview(archive: Buffer): Promise<RestorePreview> {
    const contents = await this.read(archive);
    return this.run(contents, false);
  }

  /**
   * Validates the archive again, saves a pre-restore backup of the current
   * data, then replaces every application table in one transaction and signs
   * every member and the Admin out. Any failure leaves the data unchanged.
   */
  async restore(archive: Buffer): Promise<RestoreReport> {
    const contents = await this.read(archive);
    const preRestoreBackup = await this.writePreRestoreBackup();
    const preview = await this.run(contents, true);
    return { ...preview, preRestoreBackup };
  }

  private async read(archive: Buffer) {
    const limits = await this.settings.values();
    const contents = await readBackupArchive(archive, {
      maxBytes: limits['backup.maxZipBytes'],
      maxEntries: limits['backup.maxEntries'],
      maxUncompressedBytes: limits['backup.maxUncompressedBytes'],
    });
    const { tables } = contents.database;
    if (tables.admin?.length !== 1) invalidBackup('it must contain exactly one Admin account.');
    return contents;
  }

  /** Writes the current data to `storage.backupsDir`, then prunes old pre-restore backups. */
  async writePreRestoreBackup() {
    const { config } = this.context;
    const directory = resolve(config.storage.dataDir, config.storage.backupsDir);
    const { archive } = await this.export();
    const filename = `pre-restore-backup-${stamp(this.now(), true)}-${randomBytes(3).toString('hex')}.zip`;
    try {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, filename), archive, { flag: 'wx', mode: 0o600 });
    } catch (error) {
      console.error('Pre-restore backup failed', { directory, error });
      throw new HttpError(500, 'pre_restore_backup_failed', 'The pre-restore backup could not be written, so nothing was restored. Check storage.backupsDir.');
    }
    await this.prunePreRestoreBackups(directory, filename, config.backup.preRestore.keep);
    return filename;
  }

  /** Keeps every pre-restore backup unless `keep` is set; never deletes `current`. */
  async prunePreRestoreBackups(directory: string, current: string, keep: number | undefined) {
    if (keep === undefined) return;
    const files = (await readdir(directory)).filter((name) => preRestorePattern.test(name)).sort();
    const excess = files.filter((name) => name !== current).slice(0, Math.max(0, files.length - keep));
    for (const name of excess) await rm(join(directory, name), { force: true });
  }

  private async run({ manifest, database, configText }: BackupContents, apply: boolean): Promise<RestorePreview> {
    const locked = lockedSettingKeys(this.context.config);
    const tableNames = Object.keys(database.tables);
    const counts = Object.fromEntries(tableNames.map((table) => [table, database.tables[table].length]));

    const pool = await this.context.db.pool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)', [restoreLockKey]);
      const current = await appliedMigrations(client);
      const upgrade = upgradePlan(manifest.migrations, current);
      const live = (await client.query<{ schema: string }>('SELECT current_schema() AS schema')).rows[0].schema;
      const staging = `kb_restore_${randomBytes(6).toString('hex')}`;

      // Build the backup's schema version in a staging schema, load its rows,
      // then upgrade them with this installation's remaining migrations. With
      // the search_path set to the staging schema only, a migration can never
      // resolve to a live table.
      await client.query(`CREATE SCHEMA ${quoteIdentifier(staging)}`);
      await client.query(`SET LOCAL search_path TO ${quoteIdentifier(staging)}`);
      await this.migrate(client, manifest.migrations, 'it could not be loaded at its own schema version');

      const staged = await schemaColumns(client, staging);
      const expected = [...staged.keys()].filter((table) => ![...unbackedTables, ...formerUnbackedTables].includes(table));
      if (!sameMembers(tableNames, expected)) invalidBackup('its tables do not match its schema version.');
      for (const table of tableNames) {
        const { stored } = staged.get(table)!;
        for (const row of database.tables[table]) {
          if (!sameMembers(Object.keys(row), stored)) invalidBackup(`a row in ${table} does not match the table columns.`);
        }
      }
      // Migrations may have seeded rows (such as the settings row); the backup replaces them.
      await client.query(`TRUNCATE ${[...staged.keys()].map((table) => qualified(staging, table)).join(', ')}`);
      // Rows are loaded verbatim: user triggers, such as the legacy tag bridge
      // that exists until migration 007, must not rewrite them. Foreign keys
      // are system triggers and stay enforced.
      for (const table of tableNames) await client.query(`ALTER TABLE ${qualified(staging, table)} DISABLE TRIGGER USER`);
      for (const table of tableNames) {
        if (!database.tables[table].length) continue;
        const columnList = staged.get(table)!.stored.map(quoteIdentifier).join(', ');
        await client.query(
          `INSERT INTO ${qualified(staging, table)} (${columnList})
           SELECT ${columnList} FROM jsonb_populate_recordset(NULL::${qualified(staging, table)}, $1::jsonb)`,
          [JSON.stringify(database.tables[table])],
        );
      }
      for (const table of tableNames) await client.query(`ALTER TABLE ${qualified(staging, table)} ENABLE TRIGGER USER`);
      await this.migrate(client, upgrade, 'it could not be upgraded to this version');

      // Settings config.yaml now locks are not restored (CFG-8); the report names them.
      const stagedSettings = await client.query<{ key: string }>(
        `SELECT key FROM ${qualified(staging, 'settings')} WHERE key = ANY($1::text[]) ORDER BY key`,
        [locked],
      );
      const ignored = stagedSettings.rows.map((row) => row.key);

      if (apply) await this.replaceLiveTables(client, live, staging, ignored);
      await client.query(apply ? 'COMMIT' : 'ROLLBACK');

      const currentConfig = this.context.configFile.text;
      return {
        createdAt: manifest.createdAt,
        appVersion: manifest.appVersion,
        migrations: { backup: manifest.migrations, upgrade },
        counts,
        config: {
          included: configText !== null,
          content: configText,
          diff: configText !== null && currentConfig !== null ? diffLines(currentConfig, configText) : null,
          identical: configText !== null && configText === currentConfig,
        },
        ignoredSettings: ignored,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      if (isDataError(error)) invalidBackup(describeDataError(error));
      throw error;
    } finally {
      client.release();
    }
  }

  private async migrate(client: pg.PoolClient, ids: string[], failure: string) {
    for (const migration of migrationsById(ids)) {
      try {
        await client.query(migration.sql);
      } catch (error) {
        console.error('Restore migration failed', { migration: migration.id, error });
        if (isDataError(error)) invalidBackup(`${failure}: ${describeDataError(error)}`);
        invalidBackup(`${failure} (migration ${migration.id} failed).`);
      }
    }
  }

  /** Replaces the live tables with the upgraded staging tables, without the settings config.yaml locks. */
  private async replaceLiveTables(client: pg.PoolClient, live: string, staging: string, lockedSettings: string[]) {
    await client.query(`SET LOCAL search_path TO ${quoteIdentifier(live)}`);
    const liveColumns = await schemaColumns(client, live, backupTables);
    const stagedColumns = await schemaColumns(client, staging, backupTables);
    for (const table of backupTables) {
      const liveEntry = liveColumns.get(table);
      const stagedEntry = stagedColumns.get(table);
      if (!liveEntry || !stagedEntry || !sameMembers(liveEntry.stored, stagedEntry.stored)) {
        throw new Error(`The upgraded ${table} table does not match the live schema.`);
      }
    }

    await client.query(`TRUNCATE ${[...backupTables, ...unbackedTables].map((table) => qualified(live, table)).join(', ')}`);
    for (const table of backupTables) await client.query(`ALTER TABLE ${qualified(live, table)} DISABLE TRIGGER USER`);
    for (const table of backupTables) {
      const columnList = liveColumns.get(table)!.stored.map(quoteIdentifier).join(', ');
      await client.query(
        `INSERT INTO ${qualified(live, table)} (${columnList}) SELECT ${columnList} FROM ${qualified(staging, table)}`,
      );
    }
    for (const table of backupTables) await client.query(`ALTER TABLE ${qualified(live, table)} ENABLE TRIGGER USER`);
    if (lockedSettings.length) {
      await client.query(`DELETE FROM ${qualified(live, 'settings')} WHERE key = ANY($1::text[])`, [lockedSettings]);
    }
    // Every session was truncated above, so everyone signs in again. The
    // session_version bump is kept for the 1.x member tokens' column.
    await client.query(`UPDATE ${qualified(live, 'local_users')} SET session_version = session_version + 1`);
    await client.query(`DROP SCHEMA ${quoteIdentifier(staging)} CASCADE`);
  }
}
