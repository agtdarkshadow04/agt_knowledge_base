import type { Handler } from 'aws-lambda';
import { getPool } from './db.js';
import { migrations } from './migrations.js';

export async function runMigrations() {
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
      if (exists.rowCount) continue;
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
    return { applied };
  } finally { client.release(); }
}

export const handler: Handler = async () => runMigrations();
