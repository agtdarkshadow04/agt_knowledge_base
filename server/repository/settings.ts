import type { StoredSettings } from '../context.js';
import type { Sql } from './sessions.js';
import { assertDataWrite } from '../dataWrite.js';

/** The SQL of the `settings` table (CFG-6, SRV-4). Precedence lives in `settingStates()`. */

export async function readStoredSettings(sql: Sql): Promise<StoredSettings> {
  const result = await sql.query<{ key: string; value: unknown }>('SELECT key, value FROM settings');
  return new Map(result.rows.map((row) => [row.key, row.value]));
}

/** Stores each value; `null` deletes the row, so the default applies again (CFG-8). */
export async function writeSettings(sql: Sql, values: Record<string, unknown>) {
  assertDataWrite();
  for (const [key, value] of Object.entries(values)) {
    if (value === null) {
      await sql.query('DELETE FROM settings WHERE key = $1', [key]);
    } else {
      await sql.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    }
  }
}
