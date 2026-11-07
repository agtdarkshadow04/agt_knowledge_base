import { readFileSync, statSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { backupLimitSchemas, visibilitySchema } from './validation.js';

/** Where the server looks for its configuration file unless CONFIG_FILE says otherwise. */
export const defaultConfigPath = '/app/config.yaml';

const rateLimitSchema = (max: number, windowMinutes: number) => z.object({
  max: z.number().int().min(1).max(100_000).default(max),
  windowMinutes: z.number().int().min(1).max(1440).default(windowMinutes),
}).strict().prefault({});

/**
 * The configuration file schema. Keys that can also be edited in the admin
 * dashboard have no default here: `undefined` means "not set in the file", and
 * the settings service then falls back to the dashboard value or the default.
 */
const configSchema = z.object({
  server: z.object({
    host: z.string().min(1).default('0.0.0.0'),
    port: z.number().int().min(1).max(65_535).default(3001),
    frontendOrigin: z.url().refine((value) => new URL(value).origin === value, {
      message: 'must be an origin such as https://kb.example.org, without a path or trailing slash',
    }).default('http://localhost:8080'),
    /** false: use the socket address; true: trust every X-Forwarded-For hop; n: trust n proxy hops. */
    trustProxy: z.union([z.boolean(), z.number().int().min(0).max(10)]).default(false),
  }).strict().prefault({}),
  session: z.object({
    ttlHours: z.number().min(1).max(168).default(12),
  }).strict().prefault({}),
  adminSession: z.object({
    ttlHours: z.number().min(1).max(168).default(12),
    secureCookie: z.union([z.literal('auto'), z.boolean()]).default('auto'),
  }).strict().prefault({}),
  rateLimits: z.object({
    login: rateLimitSchema(5, 1),
    adminLogin: rateLimitSchema(10, 15),
    setup: rateLimitSchema(10, 15),
    adminPassword: rateLimitSchema(10, 15),
  }).strict().prefault({}),
  storage: z.object({
    backupsDir: z.string().min(1).default('/app/data/backups'),
  }).strict().prefault({}),
  backup: z.object({
    maxBytes: backupLimitSchemas.maxBytes.optional(),
    maxEntries: backupLimitSchemas.maxEntries.optional(),
    maxUncompressedBytes: backupLimitSchemas.maxUncompressedBytes.optional(),
    preRestore: z.object({
      /** Unset keeps every pre-restore backup. */
      keep: z.number().int().min(1).max(10_000).optional(),
    }).strict().prefault({}),
  }).strict().prefault({}),
  site: z.object({
    applicationName: z.string().trim().min(1).max(80).optional(),
    applicationSubtitle: z.string().trim().min(1).max(240).optional(),
  }).strict().prefault({}),
  articles: z.object({
    defaultVisibility: visibilitySchema.optional(),
  }).strict().prefault({}),
  access: z.object({
    allowPublicBrowsing: z.boolean().optional(),
  }).strict().prefault({}),
}).strict();

export type AppConfig = z.output<typeof configSchema>;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

function describeIssue(issue: z.core.$ZodIssue) {
  const path = issue.path.map(String);
  if (issue.code === 'unrecognized_keys') {
    return issue.keys.map((key) => `${[...path, key].join('.')}: unknown key`).join('; ');
  }
  return `${path.join('.') || '(root)'}: ${issue.message}`;
}

/**
 * Treats `key:` with no value (YAML null), as left by a section whose keys are
 * all commented out, the same as an absent key.
 */
function withoutNulls(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value) || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([key, entry]) => [key, withoutNulls(entry)] as const)
    .filter(([, entry]) => entry !== undefined));
}

/** Validates configuration file text. An empty file means "all defaults". */
export function parseConfig(text: string, source = 'configuration file'): AppConfig {
  let value: unknown;
  try {
    value = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`${source} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const result = configSchema.safeParse(withoutNulls(value) ?? {});
  if (!result.success) {
    throw new ConfigError(`Invalid ${source}: ${result.error.issues.map(describeIssue).join('; ')}`);
  }
  return result.data;
}

export interface LoadedConfig {
  path: string;
  /** The raw file text, or null when no file exists (all defaults). */
  text: string | null;
  config: AppConfig;
}

export function loadConfigFile(path: string): LoadedConfig {
  let text: string;
  try {
    if (statSync(path).isDirectory()) {
      throw new ConfigError(`${path} is a directory. Create the configuration file, for example with: cp config.example.yaml config.yaml`);
    }
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, text: null, config: parseConfig('') };
    throw error;
  }
  return { path, text, config: parseConfig(text, path) };
}

let loaded: LoadedConfig | undefined;

/** The configuration file, loaded and validated once per process. */
export function getLoadedConfig(): LoadedConfig {
  loaded ??= loadConfigFile(process.env.CONFIG_FILE || defaultConfigPath);
  return loaded;
}

export function getConfig(): AppConfig {
  return getLoadedConfig().config;
}

/** Replaces the cached configuration; for tests only. */
export function setConfigForTests(config: LoadedConfig | undefined) {
  loaded = config;
}
