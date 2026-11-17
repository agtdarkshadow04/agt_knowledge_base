import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { buildApp, type BuildAppOptions } from '../app.js';
import { parseConfig } from '../config.js';
import type { AppContext } from '../context.js';
import { connectionParameters, createDatabase } from '../db.js';
import { LogStore } from '../logs.js';
import { PostgresOperations, type PostgresOperationsOptions } from '../operation.js';

/**
 * Real-PostgreSQL test servers (TEST-3). `AGT_KNOWLEDGE_BASE_TEST_DATABASE_URL`
 * names a server and a role with CREATEDB, used only by tests; every test
 * database is created through it, with its preview database, and dropped on
 * close. The app inside connects as that role, which is not a superuser, as in
 * production (DATA-11).
 */

export const testDatabaseVariable = 'AGT_KNOWLEDGE_BASE_TEST_DATABASE_URL';

export function testDatabaseUrl(): string {
  const url = process.env[testDatabaseVariable];
  if (!url) {
    throw new Error(`${testDatabaseVariable} is not set. The server tests need a PostgreSQL 18 server and a non-superuser role with CREATEDB, for example postgres://agt_test:<password>@127.0.0.1:5432/postgres (README, Development).`);
  }
  return url;
}

async function adminQuery(sql: string) {
  const client = new pg.Client({ connectionString: testDatabaseUrl() });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** A new empty database and its preview database; `drop()` removes both. */
export async function createTestDatabase() {
  const name = `agt_kb_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await adminQuery(`CREATE DATABASE ${quote(name)}`);
  await adminQuery(`CREATE DATABASE ${quote(`${name}_preview`)}`);
  return {
    name,
    async drop() {
      for (const database of [name, `${name}_preview`]) {
        await adminQuery(`DROP DATABASE IF EXISTS ${quote(database)} WITH (FORCE)`);
      }
    },
  };
}

export interface TestServerOptions {
  /** An existing test database (a second process of the same installation); a new one is created otherwise. */
  database?: string;
  /** The data directory; a second process shares the first one's (BAK-12). */
  dataDir?: string;
  /** Extra config.yaml text, appended after the database and storage keys. */
  config?: string;
  setupPassword?: string | null;
  operations?: Omit<PostgresOperationsOptions, 'log'>;
  app?: Omit<BuildAppOptions, 'logger' | 'loggerInstance'>;
}

export interface TestServer {
  app: ReturnType<typeof buildApp>;
  context: AppContext;
  operations: PostgresOperations;
  logs: LogStore;
  database: string;
  dataDir: string;
  /** Closes the app and the control connection, and drops the databases this server created. */
  close(): Promise<void>;
}

/**
 * `createTestServer()` (TEST-3): a started app on a fresh test database, the
 * way `server/index.ts` builds one: control connection, migrations under the
 * migration lock, log store. Tests call `app.inject()` and `close()` in `after()`.
 */
export async function createTestServer(options: TestServerOptions = {}): Promise<TestServer> {
  const created = options.database ? undefined : await createTestDatabase();
  const database = options.database ?? created!.name;
  const ownDataDir = options.dataDir === undefined;
  const dataDir = options.dataDir ?? mkdtempSync(join(tmpdir(), 'agt-kb-test-'));
  const url = connectionParameters({ connectionString: testDatabaseUrl(), ssl: false });
  const config = parseConfig([
    'database:',
    `  host: ${JSON.stringify(url.host)}`,
    `  port: ${url.port}`,
    `  name: ${database}`,
    `  user: ${JSON.stringify(url.user)}`,
    `  previewName: ${database}_preview`,
    'storage:',
    `  dataDir: ${JSON.stringify(dataDir)}`,
    options.config ?? '',
  ].join('\n'));
  const db = createDatabase({ host: url.host, port: url.port, database, user: url.user, password: url.password, ssl: false });
  const logs = new LogStore(db);
  const operations = new PostgresOperations({ config, db }, { pollMilliseconds: 100, ...options.operations });
  const context: AppContext = {
    config,
    configFile: { path: join(dataDir, 'config.yaml'), text: null },
    db,
    setupPassword: options.setupPassword === undefined ? 'test-setup-password-1A!' : options.setupPassword,
    version: '2.0.0',
    operations,
    logs,
    toolPath: process.env.PATH ?? '/usr/bin',
  };
  try {
    await operations.start();
    await logs.open();
  } catch (error) {
    await operations.stop();
    await db.close();
    await created?.drop();
    throw error;
  }
  const app = buildApp(context, options.app);
  await app.ready();
  let closed = false;
  return {
    app,
    context,
    operations,
    logs,
    database,
    dataDir,
    async close() {
      if (closed) return;
      closed = true;
      await app.close();
      await operations.stop();
      await db.close();
      await created?.drop();
      if (ownDataDir) rmSync(dataDir, { recursive: true, force: true });
    },
  };
}
