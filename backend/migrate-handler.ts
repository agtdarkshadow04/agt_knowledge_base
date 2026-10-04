import type { Handler } from 'aws-lambda';
import { getPool } from './db.js';
import { migrations } from './migrations.js';

interface MigrationEvent {
  targetId?: unknown;
}

export async function runMigrations(event: MigrationEvent = {}) {
  const targetId = event.targetId;
  if (targetId !== undefined && (typeof targetId !== 'string' || !migrations.some((migration) => migration.id === targetId))) {
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
      if (migration.requiresExplicitTarget && targetId === undefined && !exists.rowCount) break;
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

export const handler: Handler<MigrationEvent> = async (event) => runMigrations(event);
