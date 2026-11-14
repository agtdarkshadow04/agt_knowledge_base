import packageJson from '../package.json' with { type: 'json' };
import { buildApp } from './app.js';
import { defaultConfigPath, loadConfigFile } from './config.js';
import type { AppContext } from './context.js';
import { createDatabase, databaseSettingsFromEnv } from './db.js';
import { assertLocalAuthSecret } from './local-auth.js';

/**
 * The server entry point and the only file that reads `process.env`, decides
 * where the configuration file lives, or calls `listen()` (SRV-1). It refuses
 * to start, with one clear log line, on an invalid configuration (SRV-8).
 */

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

async function main() {
  const env = process.env;
  if (env.AUTH_MODE !== undefined && env.AUTH_MODE !== 'local') {
    fail('AUTH_MODE must be local or unset. Cognito authentication is no longer supported.');
  }

  let context: AppContext;
  try {
    const configFile = loadConfigFile(env.CONFIG_FILE || defaultConfigPath);
    context = {
      config: configFile.config,
      configFile: { path: configFile.path, text: configFile.text },
      db: createDatabase(databaseSettingsFromEnv(env)),
      setupPassword: env.AGT_SETUP_PASSWORD || null,
      localAuthSecret: assertLocalAuthSecret(env.LOCAL_AUTH_SECRET),
      version: packageJson.version,
    };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  const app = buildApp(context, {
    logger: { level: 'info', redact: ['req.headers.authorization', 'req.headers.cookie'] },
    // The built client; AGT_KNOWLEDGE_BASE_STATIC_DIR overrides it in development (CFG-2).
    staticDir: env.AGT_KNOWLEDGE_BASE_STATIC_DIR || 'dist',
  });
  app.log.info(context.configFile.text === null
    ? `No configuration file at ${context.configFile.path}; using defaults.`
    : `Loaded configuration from ${context.configFile.path}.`);
  if (context.setupPassword !== null) {
    app.log.warn('AGT_SETUP_PASSWORD is set. It is only needed until the Admin account exists: remove it from .env and restart.');
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
