import { defaultConfigPath, loadConfigFile, type AppConfig, type LoadedConfig } from './config.js';
import type { DatabaseSettings } from './db.js';

/**
 * Turns the process environment into what an entry point needs (CFG-1,
 * CFG-2). Entry points (`server/index.ts`, `scripts/*.ts`) pass `process.env`;
 * nothing else reads it (SRV-1). The 1.x variable names still work until
 * 3.0.0, each with a warning (VER-10).
 */

export type Env = Readonly<Record<string, string | undefined>>;

/** The prefix of every variable the app reads (NAME-2, CFG-2). */
export const envPrefix = 'AGT_KNOWLEDGE_BASE_';

export class StartupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StartupError';
  }
}

/**
 * Reads `AGT_KNOWLEDGE_BASE_<name>`, or else the deprecated 1.x variable, with
 * a warning. Empty values count as unset.
 */
export function envValue(env: Env, name: string, warnings: string[], deprecated?: string): string | undefined {
  const value = env[`${envPrefix}${name}`];
  if (value) return value;
  const legacy = deprecated === undefined ? undefined : env[deprecated];
  if (!legacy) return undefined;
  warnings.push(`${deprecated} is deprecated and will be removed in 3.0.0; rename it to ${envPrefix}${name}.`);
  return legacy;
}

/**
 * A database setting: config.yaml, then (for `host`) AGT_KNOWLEDGE_BASE_DATABASE_HOST,
 * then the deprecated 1.x variable, then the default.
 */
function databaseValue<T>(
  fromConfig: T | undefined,
  env: Env,
  warnings: string[],
  legacy: { name: string; key: string; parse: (value: string) => T },
  fallback: T,
): T {
  if (fromConfig !== undefined) return fromConfig;
  const value = env[legacy.name];
  if (!value) return fallback;
  warnings.push(`${legacy.name} is deprecated and will be removed in 3.0.0; set ${legacy.key} in config.yaml.`);
  return legacy.parse(value);
}

function port(name: string) {
  return (value: string) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > 65_535) throw new StartupError(`${name} must be a port number.`);
    return number;
  };
}

/** How to reach PostgreSQL: `database.*` in config.yaml and AGT_KNOWLEDGE_BASE_DB_PASSWORD. */
export function databaseSettings(config: AppConfig, env: Env, warnings: string[]): DatabaseSettings {
  const { database } = config;
  const ssl = databaseValue(database.ssl, env, warnings, { name: 'DATABASE_SSL', key: 'database.ssl', parse: (value) => value === 'true' }, false);
  let password = env[`${envPrefix}DB_PASSWORD`] || undefined;
  if (!password && env.DATABASE_URL) {
    warnings.push(`DATABASE_URL is deprecated and will be removed in 3.0.0; set database.* in config.yaml and ${envPrefix}DB_PASSWORD.`);
    return { connectionString: env.DATABASE_URL, ssl };
  }
  password ??= envValue(env, 'DB_PASSWORD', warnings, 'DB_PASSWORD');
  if (!password) throw new StartupError(`${envPrefix}DB_PASSWORD must be set (in .env) to the database password.`);

  return {
    host: database.host ?? (env[`${envPrefix}DATABASE_HOST`] || undefined)
      ?? databaseValue(undefined, env, warnings, { name: 'DB_HOST', key: `database.host (or ${envPrefix}DATABASE_HOST)`, parse: String }, 'localhost'),
    port: databaseValue(database.port, env, warnings, { name: 'DB_PORT', key: 'database.port', parse: port('DB_PORT') }, 5432),
    database: databaseValue(database.name, env, warnings, { name: 'DB_NAME', key: 'database.name', parse: String }, 'agt_knowledge_base'),
    user: databaseValue(database.user, env, warnings, { name: 'DB_USER', key: 'database.user', parse: String }, 'agt_knowledge_base'),
    password,
    ssl,
  };
}

export interface Startup {
  configFile: LoadedConfig;
  database: DatabaseSettings;
  /** AGT_KNOWLEDGE_BASE_SETUP_PASSWORD, or null when unset or empty. */
  setupPassword: string | null;
  /** Deprecated keys and variables in use; the entry point logs each one. */
  warnings: string[];
}

/** Loads config.yaml and the environment for an entry point. Throws with one clear message (SRV-8). */
export function loadStartup(env: Env): Startup {
  const warnings: string[] = [];
  if (env.AUTH_MODE !== undefined) {
    if (env.AUTH_MODE !== 'local') throw new StartupError('AUTH_MODE must be local or unset. Cognito authentication is no longer supported.');
    warnings.push('AUTH_MODE is deprecated and will be removed in 3.0.0; remove it, local accounts are the only mode.');
  }
  const path = envValue(env, 'CONFIG_FILE', warnings, 'CONFIG_FILE') ?? defaultConfigPath;
  const configFile = loadConfigFile(path, { defaultHost: env[`${envPrefix}SERVER_HOST`] || undefined });
  warnings.push(...configFile.warnings);
  const database = databaseSettings(configFile.config, env, warnings);
  const setupPassword = envValue(env, 'SETUP_PASSWORD', warnings, 'AGT_SETUP_PASSWORD') ?? null;
  return { configFile, database, setupPassword, warnings };
}
