import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import pg from 'pg';

const { Pool } = pg;
let poolPromise: Promise<pg.Pool> | undefined;

interface DatabaseSecret {
  username: string;
  password: string;
  host?: string;
  port?: number;
  dbname?: string;
}

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

  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) throw new Error('DB_SECRET_ARN, DATABASE_URL, or DB_USER/DB_PASSWORD must be configured.');
  const response = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: secretArn }));
  if (!response.SecretString) throw new Error('The database secret does not contain a SecretString.');
  const secret = JSON.parse(response.SecretString) as DatabaseSecret;

  return new Pool({
    host: process.env.DB_HOST ?? secret.host,
    port: Number(process.env.DB_PORT ?? secret.port ?? 5432),
    database: process.env.DB_NAME ?? secret.dbname ?? 'agt_knowledge_base',
    user: secret.username,
    password: secret.password,
    ssl: { rejectUnauthorized: true },
    max: 5,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
  });
}

export function getPool() {
  poolPromise ??= createPool();
  return poolPromise;
}
