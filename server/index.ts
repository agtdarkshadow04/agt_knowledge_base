import packageJson from '../package.json' with { type: 'json' };
import { buildApp } from './app.js';
import type { AppContext } from './context.js';
import { BackupService } from './backup.js';
import { CONTROL_MIGRATIONS, createDatabase, LOG_MIGRATIONS, MIGRATIONS } from './db.js';
import { createLogger, LogStore, logStoreStream, startRetention } from './logs.js';
import { MaintenanceError } from './http.js';
import { PostgresOperations, type OperationLog } from './operation.js';
import { AdminAuthService, setupPasswordVariable } from './session.js';
import { SettingsService } from './settings-service.js';
import { envPrefix, loadStartup, type Startup } from './startup.js';

/**
 * The server entry point and the only file that reads `process.env` or calls
 * `listen()` (SRV-1); `server/startup.ts` interprets the variables and loads
 * config.yaml. It refuses to start, with one clear log line, on an invalid
 * configuration (SRV-8).
 */

/** Before the logger exists, and for failures of the log store itself (LOG-3), lines go straight to stdout. */
function stdoutLine(message: string) {
  process.stdout.write(`${JSON.stringify({ level: 50, time: Date.now(), msg: message })}\n`);
}

function fail(message: string, log?: { fatal(details: object, message: string): void }): never {
  if (log) log.fatal({ source: 'startup' }, message);
  else stdoutLine(message);
  process.exit(1);
}

type StartupLog = { warn(details: object, message: string): void; fatal(details: object, message: string): void };

/**
 * AUTH-5 and AUTH-6: while no Admin exists, a set setup password must be at
 * most 1024 characters; once one exists, a still-set password is warned about
 * at every start.
 */
async function checkSetupPassword(context: AppContext, log: StartupLog) {
  if (context.setupPassword === null) return;
  let adminExists: boolean;
  try {
    adminExists = await new AdminAuthService(context).adminExists();
  } catch (error) {
    fail(`${setupPasswordVariable} is set, but the database could not be checked for an Admin account: ${error instanceof Error ? error.message : String(error)}`, log);
  }
  if (adminExists) {
    log.warn({ source: 'config' }, `The Admin account exists but ${setupPasswordVariable} is still set. Remove it from .env and restart.`);
  } else if (context.setupPassword.length > 1024) {
    fail(`${setupPasswordVariable} is longer than 1024 characters. Set a shorter value in .env and restart.`, log);
  }
}

async function main() {
  const env = process.env;
  let startup: Startup;
  try {
    startup = loadStartup(env);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  const config = startup.configFile.config;
  const db = createDatabase(startup.database);
  // LOG-5: pino writes to stdout (server.logLevel) and, from info up, to the server log.
  const logs = new LogStore(db, { report: stdoutLine });
  const logger = createLogger(config, process.stdout, logStoreStream(logs, stdoutLine));
  const backupLog: OperationLog = {
    info: (message) => logger.info({ source: 'backup' }, message),
    warn: (message) => logger.warn({ source: 'backup' }, message),
    error: (message) => logger.error({ source: 'backup' }, message),
  };
  const operations = new PostgresOperations({ config, db }, { log: backupLog });
  const context: AppContext = {
    config,
    configFile: { path: startup.configFile.path, text: startup.configFile.text },
    db,
    setupPassword: startup.setupPassword,
    version: packageJson.version,
    operations,
    logs,
    toolPath: startup.toolPath,
  };

  const app = buildApp(context, {
    loggerInstance: logger,
    // The built client; AGT_KNOWLEDGE_BASE_STATIC_DIR overrides it in development (CFG-2).
    staticDir: env[`${envPrefix}STATIC_DIR`] || 'dist',
  });
  if (context.configFile.text === null) {
    logger.warn({ source: 'config' }, `No configuration file at ${context.configFile.path}; using defaults.`);
  }
  for (const warning of startup.warnings) logger.warn({ source: 'config' }, warning);
  if (env.MIGRATION_TARGET_ID) logger.warn({ source: 'config' }, 'MIGRATION_TARGET_ID is no longer used: every migration runs at startup. Remove it.');
  if (env.LOCAL_AUTH_SECRET) logger.warn({ source: 'config' }, 'LOCAL_AUTH_SECRET is no longer used: members sign in with cookie sessions. Remove it from .env.');
  // BAK-12 startup: the control connection, then (under the migration lock) the
  // control schema, the BAK-11 failed-restore check, the log store (LOG-1) and
  // the app migrations (DATA-4, DATA-11), and the shared state, all before listening.
  try {
    await operations.start({ info: (message) => logger.info({ source: 'migrations' }, message) });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), logger);
  }
  // Entries logged so far waited in memory for the log store.
  await logs.open();
  // BAK-3: empty the preview database after a preview a crash cut short.
  await new BackupService(context, undefined, { log: backupLog }).cleanPreviewDatabase();
  await checkSetupPassword(context, logger);

  // LOG-15: retention now and every hour, each run admitted under the activity lease (BAK-12).
  const settings = new SettingsService(context);
  const retention = startRetention(logs, async () => {
    const values = await settings.values();
    return {
      serverRetentionDays: values['logs.serverRetentionDays'],
      serverMaxEntries: values['logs.serverMaxEntries'],
      auditRetentionDays: values['logs.auditRetentionDays'],
      auditMaxEntries: values['logs.auditMaxEntries'],
    };
  }, logger, () => operations.admit({ routeKey: 'job retention' }).catch((error: unknown) => {
    if (error instanceof MaintenanceError) return null;
    throw error;
  }));
  await retention.first;

  let closing = false;
  async function shutdown(signal: string) {
    if (closing) return;
    closing = true;
    logger.info({ source: 'shutdown' }, `${signal} received; shutting down.`);
    retention.stop();
    await app.close();
    await logs.flush();
    await operations.stop();
    await context.db.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const { host, port } = config.server;
  const address = await app.listen({ host, port });
  // LOG-8: the startup entry, with the versions, the address and the configuration file.
  logger.info({
    source: 'startup',
    version: packageJson.version,
    schemaVersions: { app: MIGRATIONS.at(-1)!.version, control: CONTROL_MIGRATIONS.at(-1)!.version, logs: LOG_MIGRATIONS.at(-1)!.version },
    address,
    configFile: context.configFile.text === null ? null : context.configFile.path,
  }, `AGT Knowledge Base ${packageJson.version} started on ${address}${context.configFile.text === null ? ', with the default configuration' : `, configured from ${context.configFile.path}`}.`);
}

await main();
