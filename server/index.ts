import packageJson from '../package.json' with { type: 'json' };
import { buildApp } from './app.js';
import type { AppContext } from './context.js';
import { BackupService } from './backup.js';
import { createDatabase } from './db.js';
import { PostgresOperations, type OperationLog } from './operation.js';
import { AdminAuthService, setupPasswordVariable } from './session.js';
import { envPrefix, loadStartup, type Startup } from './startup.js';

/**
 * The server entry point and the only file that reads `process.env` or calls
 * `listen()` (SRV-1); `server/startup.ts` interprets the variables and loads
 * config.yaml. It refuses to start, with one clear log line, on an invalid
 * configuration (SRV-8).
 */

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/**
 * AUTH-5 and AUTH-6: while no Admin exists, a set setup password must be at
 * most 1024 characters; once one exists, a still-set password is warned about
 * at every start.
 */
async function checkSetupPassword(context: AppContext, log: { warn(message: string): void }) {
  if (context.setupPassword === null) return;
  let adminExists: boolean;
  try {
    adminExists = await new AdminAuthService(context).adminExists();
  } catch (error) {
    fail(`${setupPasswordVariable} is set, but the database could not be checked for an Admin account: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (adminExists) {
    log.warn(`The Admin account exists but ${setupPasswordVariable} is still set. Remove it from .env and restart.`);
  } else if (context.setupPassword.length > 1024) {
    fail(`${setupPasswordVariable} is longer than 1024 characters. Set a shorter value in .env and restart.`);
  }
}

async function main() {
  const env = process.env;
  let startup: Startup;
  let context: AppContext;
  let operations: PostgresOperations;
  // The operation lock logs through the app's logger, which exists once the app is built.
  const backupLog: OperationLog = {
    info: (message) => app.log.info({ source: 'backup' }, message),
    warn: (message) => app.log.warn({ source: 'backup' }, message),
    error: (message) => app.log.error({ source: 'backup' }, message),
  };
  try {
    startup = loadStartup(env);
    const config = startup.configFile.config;
    const db = createDatabase(startup.database);
    operations = new PostgresOperations({ config, db }, { log: backupLog });
    context = {
      config,
      configFile: { path: startup.configFile.path, text: startup.configFile.text },
      db,
      setupPassword: startup.setupPassword,
      version: packageJson.version,
      operations,
      toolPath: startup.toolPath,
    };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const app = buildApp(context, {
    logger: { level: context.config.server.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie'] },
    // The built client; AGT_KNOWLEDGE_BASE_STATIC_DIR overrides it in development (CFG-2).
    staticDir: env[`${envPrefix}STATIC_DIR`] || 'dist',
  });
  if (context.configFile.text === null) {
    app.log.warn(`No configuration file at ${context.configFile.path}; using defaults.`);
  } else {
    app.log.info(`Loaded configuration from ${context.configFile.path}.`);
  }
  for (const warning of startup.warnings) app.log.warn(warning);
  if (env.MIGRATION_TARGET_ID) app.log.warn('MIGRATION_TARGET_ID is no longer used: every migration runs at startup. Remove it.');
  // BAK-12 startup: the control connection, then (under the migration lock) the
  // control schema, the BAK-11 failed-restore check and the app migrations
  // (DATA-4, DATA-11), and the shared state, all before listening.
  try {
    await operations.start({ info: (message) => app.log.info({ source: 'migrations' }, message) });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  // BAK-3: empty the preview database after a preview a crash cut short.
  await new BackupService(context, undefined, { log: backupLog }).cleanPreviewDatabase();
  if (env.LOCAL_AUTH_SECRET) app.log.warn('LOCAL_AUTH_SECRET is no longer used: members sign in with cookie sessions. Remove it from .env.');
  await checkSetupPassword(context, app.log);

  let closing = false;
  async function shutdown(signal: string) {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received; shutting down.`);
    await app.close();
    await operations.stop();
    await context.db.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const { host, port } = context.config.server;
  await app.listen({ host, port });
}

await main();
