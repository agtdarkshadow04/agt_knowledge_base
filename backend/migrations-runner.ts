import { getPool } from './db.js';
import { migrations } from './migrations.js';

export interface MigrationOptions {
  /** Apply migrations up to and including this id, including explicit-target ones. */
  targetId?: string;
}

export async function runMigrations(options: MigrationOptions = {}) {
  const { targetId } = options;
  if (targetId !== undefined && !migrations.some((migration) => migration.id === targetId)) {
    throw new Error('targetId must name a known migration.');
  }
  const pool = await getPool();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    for (const migration of migrations) {
      const exists = await client.query('SELECT 1 FROM schema_migrations WHERE id = $1', [migration.id]);
      if (migration.requiresExplicitTarget && targetId !== migration.id && !exists.rowCount) continue;
      if (!exists.rowCount) {
        await client.query('BEGIN');
        try {
          await client.query(migration.sql);
          await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [migration.id]);
          await client.query('COMMIT');
          applied.push(migration.id);
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        }
      }
      if (migration.id === targetId) break;
    }
    return { applied };
  } finally { client.release(); }
}
