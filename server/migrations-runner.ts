import type { Database } from './db.js';
import { migrations, type Migration } from './migrations.js';

export interface MigrationOptions {
  /** Apply migrations up to and including this id, including explicit-target ones. */
  targetId?: string;
}

interface QueryClient {
  query(sql: string, values?: unknown[]): Promise<unknown>;
}

/** Looks up migrations by id, keeping the order given. Unknown ids throw. */
export function migrationsById(ids: readonly string[]): Migration[] {
  return ids.map((id) => {
    const migration = migrations.find((candidate) => candidate.id === id);
    if (!migration) throw new Error(`Unknown migration ${id}.`);
    return migration;
  });
}

/**
 * Runs the SQL of the given migrations, in order, on a client that is already
 * inside a transaction. It does not record them in schema_migrations. Backup
 * restore uses this to build a staging schema under its own search_path, which
 * is why migrations must never schema-qualify their objects.
 */
export async function applyMigrationSql(client: QueryClient, ids: readonly string[]) {
  for (const migration of migrationsById(ids)) await client.query(migration.sql);
}

export async function runMigrations(db: Database, options: MigrationOptions = {}) {
  const { targetId } = options;
  if (targetId !== undefined && !migrations.some((migration) => migration.id === targetId)) {
    throw new Error('targetId must name a known migration.');
  }
  const pool = await db.pool();
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
          await applyMigrationSql(client, [migration.id]);
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
