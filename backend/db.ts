import pg from 'pg';

const { Pool } = pg;
let poolPromise: Promise<pg.Pool> | undefined;

async function createPool() {
  if (process.env.DATABASE_URL) {
    return new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
  }

  if (process.env.DB_USER || process.env.DB_PASSWORD) {
    if (!process.env.DB_USER || !process.env.DB_PASSWORD) {
      throw new Error('DB_USER and DB_PASSWORD must be configured together.');
    }
    return new Pool({
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      database: process.env.DB_NAME ?? 'agt_knowledge_base',
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: true } : false,
      max: 5,
      connectionTimeoutMillis: 5_000,
      idleTimeoutMillis: 30_000,
    });
  }

  throw new Error('DATABASE_URL or DB_USER/DB_PASSWORD must be configured.');
}

export function getPool() {
  poolPromise ??= createPool();
  return poolPromise;
}
