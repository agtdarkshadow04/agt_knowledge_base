import pg from 'pg';

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

/** A database backed by one `pg.Pool`, created lazily on first use. */
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
