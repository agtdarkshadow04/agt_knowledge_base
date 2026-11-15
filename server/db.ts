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

const { Pool } = pg;

/** How to reach PostgreSQL. `databaseSettings()` in `server/startup.ts` builds it; a connection string only from the deprecated DATABASE_URL. */
export type DatabaseSettings =
  | { connectionString: string; ssl: boolean }
  | { host: string; port: number; database: string; user: string; password: string; ssl: boolean };

/**
 * The app's database handle. Services ask it for the pool on every use, so a
 * future restore can swap the pool without rebuilding the services (SRV-3).
 */
export interface Database {
  pool(): Promise<pg.Pool>;
  close(): Promise<void>;
}

const poolOptions = { max: 5, connectionTimeoutMillis: 5_000, idleTimeoutMillis: 30_000 };

/** A database backed by one `pg.Pool`, created lazily on first use (DATA-11). */
export function createDatabase(settings: DatabaseSettings): Database {
  let pool: pg.Pool | undefined;
  return {
    async pool() {
      pool ??= new Pool({
        ...settings,
        ssl: settings.ssl ? { rejectUnauthorized: true } : false,
        ...poolOptions,
      });
      return pool;
    },
    async close() {
      const current = pool;
      pool = undefined;
      await current?.end();
    },
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

/** The 1.x name of a migration (`001_initial`), used by backup manifests until the Phase 6 backup format. */
export function migrationId(migration: Pick<Migration, 'version' | 'name'>) {
  return `${String(migration.version).padStart(3, '0')}_${migration.name}`;
}

/** Looks up migrations by their 1.x id, keeping the order given. Unknown ids throw. */
export function migrationsById(ids: readonly string[]): Migration[] {
  return ids.map((id) => {
    const migration = MIGRATIONS.find((candidate) => migrationId(candidate) === id);
    if (!migration) throw new Error(`Unknown migration ${id}.`);
    return migration;
  });
}

/**
 * Runs the SQL of the given migrations, in order, on a client that is already
 * inside a transaction, without recording them. Backup restore uses this to
 * build a staging schema under its own search_path, which is why migrations
 * never schema-qualify their objects.
 */
export async function applyMigrationSql(client: Pick<Queryable, 'query'>, ids: readonly string[]) {
  for (const migration of migrationsById(ids)) await client.query(migration.sql);
}

export class StartupCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupCheckError';
  }
}

/** `(0, hashtext('agt_knowledge_base_migrations'))`: processes that start together migrate one at a time (BAK-12). */
const migrationLock = "SELECT pg_advisory_lock(0, hashtext('agt_knowledge_base_migrations'))";
const migrationUnlock = "SELECT pg_advisory_unlock(0, hashtext('agt_knowledge_base_migrations'))";

/** Turns the 1.x `schema_migrations (id text, applied_at)` into the DATA-11 `(version, name, applied_at)` table. */
async function prepareVersionTable(client: Pick<Queryable, 'query'>) {
  const columns = (await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'schema_migrations'`,
  )).rows.map((row) => (row as { column_name: string }).column_name);
  if (!columns.length) {
    await client.query(`CREATE TABLE schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    return;
  }
  if (!columns.includes('id')) return;
  await client.query('BEGIN');
  try {
    await client.query(`CREATE TABLE schema_migrations_v2 (
      version integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
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
export async function appliedVersions(client: Pick<Queryable, 'query'>): Promise<number[]> {
  const result = await client.query('SELECT version FROM schema_migrations ORDER BY version');
  return result.rows.map((row) => Number((row as { version: number }).version));
}

/**
 * Refuses to start (SRV-8) when the database role is a superuser (DATA-11),
 * then applies every pending migration at startup, each in its own
 * transaction, under the migration lock (DATA-4, BAK-12). A database with a
 * migration this version does not know (a newer schema) stops the server.
 */
export async function runMigrations(db: Pick<Database, 'pool'>, log: { info(message: string): void } = { info: () => undefined }) {
  const pool = await db.pool();
  const client = await pool.connect();
  const applied: number[] = [];
  let locked = false;
  try {
    const superuser = await client.query('SELECT rolsuper FROM pg_roles WHERE rolname = current_user');
    if ((superuser.rows[0] as { rolsuper?: boolean } | undefined)?.rolsuper) {
      throw new StartupCheckError('The database role is a superuser. Connect as the agt_knowledge_base role (database.user); see deploy/upgrade-database-role.sql to create it.');
    }
    await client.query(migrationLock);
    locked = true;
    await prepareVersionTable(client);
    const done = new Set(await appliedVersions(client));
    const latest = MIGRATIONS.at(-1)!.version;
    const unknown = [...done].filter((version) => !MIGRATIONS.some((migration) => migration.version === version));
    if (unknown.length) {
      throw new StartupCheckError(`The database schema is newer than this version of AGT Knowledge Base supports (migration ${Math.max(...unknown)}; this version knows up to ${latest}). Install a newer version.`);
    }
    for (const migration of MIGRATIONS) {
      if (done.has(migration.version)) continue;
      await client.query('BEGIN');
      try {
        await client.query(migration.sql);
        await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [migration.version, migration.name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
      applied.push(migration.version);
      log.info(`Applied migration ${String(migration.version).padStart(4, '0')}_${migration.name}.`);
    }
    return { applied };
  } finally {
    if (locked) await client.query(migrationUnlock).catch(() => undefined);
    client.release();
  }
}
