import type { Sql } from './control.js';

/**
 * The SQL of backup and restore (SRV-4): the preview database, the checks on a
 * restored dump and the BAK-4 step 6.1 commit. `server/backup.ts` holds the
 * rules; `pg_dump` and `pg_restore` run as child processes.
 */

/** The server's `server_version_num`, e.g. 160004 (BAK-6). */
export async function serverVersionNumber(sql: Sql) {
  return Number((await sql.query<{ server_version_num: string }>('SHOW server_version_num')).rows[0].server_version_num);
}

/** Empties a database's public schema: the preview database before and after each preview (BAK-3). */
export async function emptyPublicSchema(sql: Sql) {
  await sql.query('DROP SCHEMA IF EXISTS public CASCADE');
  await sql.query('CREATE SCHEMA public');
}

export async function publicTables(sql: Sql) {
  const result = await sql.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'",
  );
  return new Set(result.rows.map((row) => row.table_name));
}

/** Rows in one of the app's own tables; `table` comes from `EXPECTED_TABLES`, never from input. */
export async function rowCount(sql: Sql, table: string) {
  if (!/^[a-z_]+$/.test(table)) throw new Error(`Not a table name: ${table}`);
  return Number((await sql.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`)).rows[0].count);
}

export async function adminPasswordHashes(sql: Sql) {
  return (await sql.query<{ password_hash: string }>('SELECT password_hash FROM admin')).rows.map((row) => row.password_hash);
}

/** The stored dashboard settings among `keys`, sorted. */
export async function storedSettingKeys(sql: Sql, keys: readonly string[]) {
  if (!keys.length) return [];
  return (await sql.query<{ key: string }>('SELECT key FROM settings WHERE key = ANY($1::text[]) ORDER BY key', [keys])).rows.map((row) => row.key);
}

/**
 * BAK-4 step 6.1, in one transaction on the restored data: deletes the
 * settings config.yaml now locks and every session row.
 */
export async function commitRestore(sql: Sql, lockedKeys: readonly string[], sessionTables: readonly string[]) {
  await sql.query('BEGIN');
  try {
    if (lockedKeys.length) await sql.query('DELETE FROM settings WHERE key = ANY($1::text[])', [lockedKeys]);
    for (const table of sessionTables) await sql.query(`DELETE FROM ${table}`);
    await sql.query('COMMIT');
  } catch (error) {
    await sql.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}
