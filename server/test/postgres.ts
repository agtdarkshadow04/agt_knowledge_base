import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { createAdminRequestHandler } from '../adminRoutes.js';
import { buildApp, type BuildAppOptions } from '../app.js';
import { postgresTools, type ToolRunner } from '../backup.js';
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

/**
 * Drops a test database. `WITH (FORCE)` ends any session the test left open,
 * but it may not end an autovacuum worker, which no non-superuser role may
 * signal: PostgreSQL then refuses with 42501 "permission denied to terminate
 * process". Autovacuum starts on its own after enough writes, so this happens
 * now and then under load. A plain `DROP DATABASE` stops autovacuum workers
 * itself, so that case retries without FORCE.
 */
async function dropDatabase(name: string) {
  try {
    await adminQuery(`DROP DATABASE IF EXISTS ${quote(name)} WITH (FORCE)`);
  } catch (error) {
    if ((error as { code?: string }).code !== '42501') throw error;
    await adminQuery(`DROP DATABASE IF EXISTS ${quote(name)}`);
  }
}

/**
 * Closes every test server, in order, even when one of them fails to close,
 * then throws the first failure. A server left open keeps polling its control
 * connection, so the test process would never exit.
 */
export async function closeTestServers(servers: Iterable<{ close(): Promise<void> }>) {
  const failures: unknown[] = [];
  for (const server of servers) {
    try {
      await server.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, `${failures.length} test servers failed to close.`);
}

/** A new empty database and its preview database; `drop()` removes both. */
export async function createTestDatabase() {
  const name = `agt_kb_test_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  await adminQuery(`CREATE DATABASE ${quote(name)}`);
  await adminQuery(`CREATE DATABASE ${quote(`${name}_preview`)}`);
  return {
    name,
    async drop() {
      for (const database of [name, `${name}_preview`]) await dropDatabase(database);
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
  /** AGT_KNOWLEDGE_BASE_IAM_API_KEY. */
  iamApiKey?: string;
  operations?: Omit<PostgresOperationsOptions, 'log'>;
  /** Wraps the real `pg_dump`/`pg_restore` runner, to pause or fail a backup, preview or restore (TEST-4). */
  backupTools?: (real: ToolRunner) => ToolRunner;
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
    iamApiKey: options.iamApiKey ?? null,
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
  const handlers = { ...options.app?.handlers };
  if (options.backupTools && !handlers.admin) {
    handlers.admin = createAdminRequestHandler(context, { backup: { tools: options.backupTools(postgresTools(db.connection(), context.toolPath)) } });
  }
  const app = buildApp(context, { ...options.app, handlers });
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
      // Every step runs even if an earlier one fails, so nothing keeps polling or stays connected.
      let failure: unknown;
      for (const step of [() => app.close(), () => operations.stop(), () => db.close(), () => created?.drop()]) {
        try {
          await step();
        } catch (error) {
          failure ??= error;
        }
      }
      if (ownDataDir) rmSync(dataDir, { recursive: true, force: true });
      if (failure !== undefined) throw failure;
    },
  };
}
