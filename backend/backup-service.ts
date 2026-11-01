import type pg from 'pg';
import { getPool } from './db.js';
import { AppError, type Actor } from './domain.js';

export const backupFormat = 'agt-knowledge-base-backup';
export const backupFormatVersion = 1;

/**
 * Every application table, in an order that satisfies foreign keys on insert.
 * `schema_migrations` is not copied: it is compared instead, so a backup only
 * restores into a database with exactly the same schema.
 */
export const backupTables = [
  'app_users',
  'local_users',
  'tags',
  'articles',
  'article_revisions',
  'application_settings',
] as const;

export type BackupTable = typeof backupTables[number];
export type BackupRow = Record<string, unknown>;

export interface DatabaseBackup {
  format: typeof backupFormat;
  formatVersion: typeof backupFormatVersion;
  createdAt: string;
  migrations: string[];
  tables: Record<BackupTable, BackupRow[]>;
}

export type BackupCounts = Record<BackupTable, number>;

interface ColumnRow {
  table_name: string;
  column_name: string;
  is_generated: string;
}

function quoteIdentifier(name: string) {
  return `"${name.replace(/"/g, '""')}"`;
}

async function assertActiveSuperAdmin(client: pg.PoolClient, actor: Actor) {
  const result = await client.query(
    `SELECT 1
     FROM local_users
     WHERE id = $1 AND is_active = true AND is_super_admin = true AND role = 'Admin'`,
    [actor.sub],
  );
  if (!result.rowCount) {
    throw new AppError('Only the super administrator can back up or restore the database.', 403, 'FORBIDDEN');
  }
}

async function appliedMigrations(client: pg.PoolClient) {
  const result = await client.query<{ id: string }>('SELECT id FROM schema_migrations ORDER BY id');
  return result.rows.map((row) => row.id);
}

/** Stored (non-generated) and generated column names of each backup table. */
async function tableColumns(client: pg.PoolClient) {
  const result = await client.query<ColumnRow>(
    `SELECT table_name, column_name, is_generated
     FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = ANY($1::text[])
     ORDER BY table_name, ordinal_position`,
    [backupTables],
  );
  const columns = new Map<BackupTable, { stored: string[]; generated: string[] }>(
    backupTables.map((table) => [table, { stored: [], generated: [] }]),
  );
  for (const row of result.rows) {
    const entry = columns.get(row.table_name as BackupTable);
    if (!entry) continue;
    (row.is_generated === 'ALWAYS' ? entry.generated : entry.stored).push(row.column_name);
  }
  for (const [table, entry] of columns) {
    if (!entry.stored.length) throw new Error(`The ${table} table is missing.`);
  }
  return columns;
}

function counts(tables: Record<BackupTable, unknown[]>): BackupCounts {
  return Object.fromEntries(backupTables.map((table) => [table, tables[table].length])) as BackupCounts;
}

function sameMembers(left: string[], right: string[]) {
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.length === sortedRight.length && sortedLeft.every((value, index) => value === sortedRight[index]);
}

function invalidBackup(message: string): never {
  throw new AppError(`The backup cannot be restored: ${message}`, 400, 'INVALID_BACKUP');
}

interface DatabaseError {
  code: string;
  table?: string;
  constraint?: string;
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

export class BackupService {
  /** Exports every application table from a single consistent snapshot. */
  async export(actor: Actor): Promise<DatabaseBackup> {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await assertActiveSuperAdmin(client, actor);
      const migrations = await appliedMigrations(client);
      const columns = await tableColumns(client);
      const tables = {} as Record<BackupTable, BackupRow[]>;
      for (const table of backupTables) {
        const result = await client.query<{ rows: BackupRow[] }>(
          `SELECT coalesce(jsonb_agg(to_jsonb(source) - $1::text[]), '[]'::jsonb) AS rows
           FROM ${quoteIdentifier(table)} source`,
          [columns.get(table)!.generated],
        );
        tables[table] = result.rows[0]?.rows ?? [];
      }
      await client.query('COMMIT');
      return {
        format: backupFormat,
        formatVersion: backupFormatVersion,
        createdAt: new Date().toISOString(),
        migrations,
        tables,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Replaces every application table with the backup contents in one
   * transaction, then signs out every user. Any failure leaves the current
   * data untouched.
   */
  async restore(backup: DatabaseBackup, actor: Actor): Promise<BackupCounts> {
    const superAdmins = backup.tables.local_users.filter((row) => row.is_super_admin === true);
    if (superAdmins.length !== 1 || superAdmins[0].is_active !== true || superAdmins[0].role !== 'Admin') {
      invalidBackup('it must contain exactly one active super administrator.');
    }
    if (backup.tables.application_settings.length !== 1) {
      invalidBackup('it must contain exactly one application settings row.');
    }

    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertActiveSuperAdmin(client, actor);
      const migrations = await appliedMigrations(client);
      if (!sameMembers(migrations, backup.migrations)) {
        invalidBackup('it was created with a different database schema version. Restore it into an installation running the same version.');
      }
      const columns = await tableColumns(client);
      for (const table of backupTables) {
        const stored = columns.get(table)!.stored;
        for (const row of backup.tables[table]) {
          if (!sameMembers(Object.keys(row), stored)) {
            invalidBackup(`a row in ${table} does not match the table columns.`);
          }
        }
      }

      await client.query(`TRUNCATE ${backupTables.map(quoteIdentifier).join(', ')}`);
      // Rows are restored verbatim: user triggers, such as the legacy tag
      // bridge that is active until migration 007, must not rewrite them.
      // Foreign keys are system triggers and stay enforced.
      for (const table of backupTables) {
        await client.query(`ALTER TABLE ${quoteIdentifier(table)} DISABLE TRIGGER USER`);
      }
      for (const table of backupTables) {
        if (!backup.tables[table].length) continue;
        const columnList = columns.get(table)!.stored.map(quoteIdentifier).join(', ');
        await client.query(
          `INSERT INTO ${quoteIdentifier(table)} (${columnList})
           SELECT ${columnList} FROM jsonb_populate_recordset(NULL::${quoteIdentifier(table)}, $1::jsonb)`,
          [JSON.stringify(backup.tables[table])],
        );
      }
      for (const table of backupTables) {
        await client.query(`ALTER TABLE ${quoteIdentifier(table)} ENABLE TRIGGER USER`);
      }
      // Restored session versions could match tokens issued before the backup
      // was taken; bumping them signs every user out.
      await client.query('UPDATE local_users SET session_version = session_version + 1');
      await client.query('COMMIT');
      return counts(backup.tables);
    } catch (error) {
      await client.query('ROLLBACK');
      if (isDataError(error)) invalidBackup(describeDataError(error));
      throw error;
    } finally {
      client.release();
    }
  }
}
