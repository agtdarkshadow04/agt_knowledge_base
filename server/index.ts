import packageJson from '../package.json' with { type: 'json' };
import { buildApp } from './app.js';
import type { AppContext } from './context.js';
import { createDatabase } from './db.js';
import { assertLocalAuthSecret } from './local-auth.js';
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

async function main() {
  const env = process.env;
  let startup: Startup;
  let context: AppContext;
  try {
    startup = loadStartup(env);
    context = {
      config: startup.configFile.config,
      configFile: { path: startup.configFile.path, text: startup.configFile.text },
      db: createDatabase(startup.database),
      setupPassword: startup.setupPassword,
      localAuthSecret: assertLocalAuthSecret(env.LOCAL_AUTH_SECRET),
      version: packageJson.version,
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
  if (context.setupPassword !== null) {
    app.log.warn(`${envPrefix}SETUP_PASSWORD is set. It is only needed until the Admin account exists: remove it from .env and restart.`);
  }

  let closing = false;
  async function shutdown(signal: string) {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received; shutting down.`);
    await app.close();
    await context.db.close();
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const { host, port } = context.config.server;
  await app.listen({ host, port });
}

await main();
