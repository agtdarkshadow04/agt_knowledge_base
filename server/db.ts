import pg from 'pg';

const { Pool } = pg;

/** How to reach PostgreSQL. `server/index.ts` builds it from the environment. */
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

/** Reads the database settings from environment variables. Only entry points pass `process.env`. */
export function databaseSettingsFromEnv(env: Record<string, string | undefined>): DatabaseSettings {
  const ssl = env.DATABASE_SSL === 'true';
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL, ssl };
  if (env.DB_USER || env.DB_PASSWORD) {
    if (!env.DB_USER || !env.DB_PASSWORD) {
      throw new Error('DB_USER and DB_PASSWORD must be configured together.');
    }
    return {
      host: env.DB_HOST ?? 'localhost',
      port: Number(env.DB_PORT ?? 5432),
      database: env.DB_NAME ?? 'agt_knowledge_base',
      user: env.DB_USER,
      password: env.DB_PASSWORD,
      ssl,
    };
  }
  throw new Error('DATABASE_URL or DB_USER/DB_PASSWORD must be configured.');
}

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
