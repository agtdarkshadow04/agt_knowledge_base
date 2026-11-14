import { readFileSync, statSync } from 'node:fs';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { parse as parseYaml } from 'yaml';
import { backupLimits } from '../src/lib/validation.js';

/**
 * `config.yaml`: its TypeBox schema (CFG-3), the standard keys (CFG-5) and the
 * dashboard-editable settings (CFG-6). Only `server/startup.ts` decides where
 * the file lives; nothing here reads the environment (SRV-1).
 */

/** Where the server looks for its configuration file unless AGT_KNOWLEDGE_BASE_CONFIG_FILE says otherwise. */
export const defaultConfigPath = './config.yaml';

/** The default listen port, from the spec's app registry (§2.1). */
export const defaultPort = 8081;

const nonBlank = (maxLength: number) => Type.String({ minLength: 1, maxLength, pattern: '\\S' });
const integer = (minimum: number, maximum: number) => Type.Integer({ minimum, maximum });

const Visibility = Type.Union([
  Type.Literal('Public'),
  Type.Literal('Internal'),
  Type.Literal('Admin'),
  Type.Literal(0),
  Type.Literal(1),
  Type.Literal(2),
  Type.Literal(3),
  Type.Literal(4),
  Type.Literal(5),
]);

interface EditableSetting<T extends TSchema = TSchema> {
  schema: T;
  default: Static<T>;
  description: string;
}

const editable = <T extends TSchema>(schema: T, defaultValue: Static<T>, description: string): EditableSetting<T> => ({
  schema,
  default: defaultValue,
  description,
});

/**
 * Settings the Admin can change in the dashboard (CFG-6), by dotted key. Only
 * these keys are stored in the `settings` table, and each `schema` validates
 * both the dashboard value and the same key in `config.yaml`, which wins (CFG-7).
 */
export const EDITABLE_SETTINGS = {
  'site.title': editable(nonBlank(100), 'AGT Knowledge Base', 'Name shown in the header and the browser title.'),
  'site.subtitle': editable(
    nonBlank(240),
    'Field-tested guides, community procedures, and traveller intelligence.',
    'Subtitle shown under the name on the home page.',
  ),
  'site.supportUrl': editable(
    Type.String({ maxLength: 2000, pattern: '^https?://[^\\s/?#]+[^\\s]*$' }),
    'https://www.nms-agt.com/support',
    'Support link: an absolute http: or https: URL.',
  ),
  'articles.defaultVisibility': editable(
    Visibility,
    'Internal',
    'Visibility of new articles: Public, Internal, Admin (legacy) or 0-5.',
  ),
  'access.allowPublicBrowsing': editable(Type.Boolean(), true, 'Whether visitors who are not signed in can browse public articles.'),
  'backup.maxZipBytes': editable(
    integer(backupLimits.maxZipBytes.min, backupLimits.maxZipBytes.max),
    100 * 1024 * 1024,
    'Largest backup upload in bytes.',
  ),
  'backup.maxUncompressedBytes': editable(
    integer(backupLimits.maxUncompressedBytes.min, backupLimits.maxUncompressedBytes.max),
    256 * 1024 * 1024,
    'Largest total uncompressed size of an uploaded backup, in bytes.',
  ),
  'backup.maxEntries': editable(
    integer(backupLimits.maxEntries.min, backupLimits.maxEntries.max),
    16,
    'Most entries an uploaded backup archive may contain.',
  ),
} satisfies Record<string, EditableSetting>;

export type SettingKey = keyof typeof EDITABLE_SETTINGS;
export type SettingValues = { -readonly [Key in SettingKey]: Static<typeof EDITABLE_SETTINGS[Key]['schema']> };
export const settingKeys = Object.keys(EDITABLE_SETTINGS) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.hasOwn(EDITABLE_SETTINGS, key);
}

/** Whether `value` is allowed for `key` (CFG-6). */
export function validSetting(key: SettingKey, value: unknown) {
  return Value.Check(EDITABLE_SETTINGS[key].schema, value);
}

const optional = <T extends TSchema>(schema: T) => Type.Optional(schema);
const group = <T extends Record<string, TSchema>>(properties: T) => Type.Object(properties, { additionalProperties: false, default: {} });
const fileSetting = <Key extends SettingKey>(key: Key) => optional(EDITABLE_SETTINGS[key].schema as typeof EDITABLE_SETTINGS[Key]['schema']);
const rateLimit = (max: number, windowMinutes: number) => Type.Object({
  max: Type.Integer({ minimum: 1, maximum: 100_000, default: max }),
  windowMinutes: Type.Integer({ minimum: 1, maximum: 1440, default: windowMinutes }),
}, { additionalProperties: false, default: {} });
/** The 1.x per-route limits; their 1.x defaults apply to whatever an entry leaves out. */
const deprecatedRateLimit = Type.Object({
  max: Type.Integer({ minimum: 1, maximum: 100_000, default: 10 }),
  windowMinutes: Type.Integer({ minimum: 1, maximum: 1440, default: 15 }),
}, { additionalProperties: false });

const TrustProxy = Type.Union([
  Type.Boolean(),
  Type.String({ minLength: 1 }),
  Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  // A number of proxy hops; the Compose stack's Nginx is one (see AGENTS.md deviations).
  integer(0, 10),
]);

/**
 * The configuration file schema. Every key is optional. Dashboard-editable
 * keys have no default here: `undefined` means "not set in the file", and
 * `settingStates()` falls back to the dashboard value or the default.
 * Keys described as deprecated are 1.x names, accepted until 3.0.0 (VER-10).
 */
export const ConfigSchema = Type.Object({
  server: group({
    host: optional(Type.String({ minLength: 1 })),
    port: Type.Integer({ minimum: 1, maximum: 65_535, default: defaultPort }),
    trustProxy: Type.Union(TrustProxy.anyOf, { default: false }),
    logLevel: Type.Union(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'].map((level) => Type.Literal(level)), { default: 'info' }),
    /** Deprecated: only used for CORS and the `auto` Secure cookie until 3.0.0. */
    frontendOrigin: optional(Type.String({ pattern: '^https?://[^/\\s]+$' })),
  }),
  storage: group({
    dataDir: Type.String({ minLength: 1, default: 'data' }),
    backupsDir: Type.String({ minLength: 1, default: 'backups' }),
  }),
  database: group({
    host: optional(Type.String({ minLength: 1 })),
    port: optional(integer(1, 65_535)),
    name: optional(Type.String({ minLength: 1 })),
    previewName: Type.String({ minLength: 1, default: 'agt_knowledge_base_preview' }),
    user: optional(Type.String({ minLength: 1 })),
    ssl: optional(Type.Boolean()),
  }),
  session: group({
    ttlHours: Type.Number({ minimum: 1, maximum: 168, default: 12 }),
    secureCookie: optional(Type.Union([Type.Literal('auto'), Type.Boolean()])),
  }),
  /** Deprecated: `session.ttlHours` and `session.secureCookie` replace it. */
  adminSession: group({
    ttlHours: optional(Type.Number({ minimum: 1, maximum: 168 })),
    secureCookie: optional(Type.Union([Type.Literal('auto'), Type.Boolean()])),
  }),
  rateLimits: group({
    login: rateLimit(10, 15),
    setup: rateLimit(10, 15),
    adminUploads: rateLimit(120, 15),
    /** Deprecated: Admin sign-in uses `login` unless this is set. */
    adminLogin: optional(deprecatedRateLimit),
    /** Deprecated: the Admin password change uses `login` unless this is set. */
    adminPassword: optional(deprecatedRateLimit),
  }),
  site: group({
    title: fileSetting('site.title'),
    subtitle: fileSetting('site.subtitle'),
    supportUrl: fileSetting('site.supportUrl'),
  }),
  backup: group({
    maxZipBytes: fileSetting('backup.maxZipBytes'),
    maxUncompressedBytes: fileSetting('backup.maxUncompressedBytes'),
    maxEntries: fileSetting('backup.maxEntries'),
    preRestore: group({
      /** Unset keeps every pre-restore backup. */
      keep: optional(integer(1, 10_000)),
    }),
  }),
  articles: group({ defaultVisibility: fileSetting('articles.defaultVisibility') }),
  access: group({ allowPublicBrowsing: fileSetting('access.allowPublicBrowsing') }),
}, { additionalProperties: false });

type ParsedConfig = Static<typeof ConfigSchema>;

/** The validated configuration with every default applied; `server.host` and `session.secureCookie` are always resolved. */
export type AppConfig = ParsedConfig & {
  server: ParsedConfig['server'] & { host: string };
  session: ParsedConfig['session'] & { secureCookie: 'auto' | boolean };
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/** 1.x keys moved to their CFG-5 names; the old name still works until 3.0.0 with a warning. */
const renamedKeys: ReadonlyArray<readonly [string, string]> = [
  ['site.applicationName', 'site.title'],
  ['site.applicationSubtitle', 'site.subtitle'],
  ['backup.maxBytes', 'backup.maxZipBytes'],
  ['adminSession.secureCookie', 'session.secureCookie'],
];

/** Deprecated keys that keep their own meaning until 3.0.0. */
const deprecatedKeys: Record<string, string> = {
  'server.frontendOrigin': 'it is only used for CORS and the `auto` Secure cookie, both of which change in a later 2.x release',
  'adminSession.ttlHours': 'use session.ttlHours, which sets the Admin session lifetime when this key is absent',
  'rateLimits.adminLogin': 'use rateLimits.login, which applies to Admin sign-in when this key is absent',
  'rateLimits.adminPassword': 'use rateLimits.login, which applies to the Admin password change when this key is absent',
};

type Tree = Record<string, unknown>;

function isTree(value: unknown): value is Tree {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function getPath(tree: Tree, key: string): unknown {
  let node: unknown = tree;
  for (const part of key.split('.')) {
    if (!isTree(node)) return undefined;
    node = node[part];
  }
  return node;
}

function setPath(tree: Tree, key: string, value: unknown) {
  const parts = key.split('.');
  let node = tree;
  for (const part of parts.slice(0, -1)) {
    if (!isTree(node[part])) node[part] = {};
    node = node[part] as Tree;
  }
  node[parts.at(-1)!] = value;
}

function deletePath(tree: Tree, key: string) {
  const parts = key.split('.');
  const parent = getPath(tree, parts.slice(0, -1).join('.'));
  if (isTree(parent)) delete parent[parts.at(-1)!];
}

/** The value `config.yaml` sets for a key, or undefined. */
export function configValue(config: AppConfig, key: string): unknown {
  return getPath(config as unknown as Tree, key);
}

/**
 * Treats `key:` with no value (YAML null), as left by a section whose keys are
 * all commented out, the same as an absent key.
 */
function withoutNulls(value: unknown): unknown {
  if (value === null) return undefined;
  if (Array.isArray(value) || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value as Tree)
    .map(([key, entry]) => [key, withoutNulls(entry)] as const)
    .filter(([, entry]) => entry !== undefined));
}

function describeErrors(value: unknown) {
  const messages = new Map<string, string>();
  for (const error of Value.Errors(ConfigSchema, value)) {
    const path = error.path.slice(1).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~')).join('.') || '(root)';
    // A union reports each branch; the first message for a key is enough.
    if (!messages.has(path)) messages.set(path, error.message);
  }
  return [...messages].map(([path, message]) => `${path}: ${message}`).join('; ');
}

export interface ConfigOptions {
  /** Names the file in error messages. */
  source?: string;
  /** `server.host` when the file does not set it (AGT_KNOWLEDGE_BASE_SERVER_HOST, CFG-2). */
  defaultHost?: string;
}

export interface ParsedConfigResult {
  config: AppConfig;
  /** One line for each deprecated key the file uses; the server logs them at startup. */
  warnings: string[];
}

/**
 * Validates configuration file text (CFG-3). An empty file means "all
 * defaults". Unknown keys and invalid values throw a `ConfigError` naming the
 * key, e.g. `Invalid config.yaml: server.prot: Unexpected property`.
 */
export function readConfig(text: string, options: ConfigOptions = {}): ParsedConfigResult {
  const source = options.source ?? 'configuration file';
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`${source} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const tree = withoutNulls(raw) ?? {};
  if (!isTree(tree)) throw new ConfigError(`Invalid ${source}: (root): Expected object`);

  const warnings: string[] = [];
  for (const [from, to] of renamedKeys) {
    const value = getPath(tree, from);
    if (value === undefined) continue;
    if (getPath(tree, to) !== undefined) {
      throw new ConfigError(`Invalid ${source}: ${from}: deprecated name of ${to}, which is also set; remove ${from}`);
    }
    deletePath(tree, from);
    setPath(tree, to, value);
    warnings.push(`${source}: ${from} is deprecated and will be removed in 3.0.0; rename it to ${to}.`);
  }
  for (const [key, advice] of Object.entries(deprecatedKeys)) {
    if (getPath(tree, key) !== undefined) warnings.push(`${source}: ${key} is deprecated and will be removed in 3.0.0; ${advice}.`);
  }

  // Defaults fill only absent keys; every value the file sets is then checked.
  const withDefaults = Value.Default(ConfigSchema, structuredClone(tree));
  if (!Value.Check(ConfigSchema, withDefaults)) throw new ConfigError(`Invalid ${source}: ${describeErrors(withDefaults)}`);
  const parsed = withDefaults as ParsedConfig;
  const config: AppConfig = {
    ...parsed,
    server: { ...parsed.server, host: parsed.server.host ?? options.defaultHost ?? '127.0.0.1' },
    session: { ...parsed.session, secureCookie: parsed.session.secureCookie ?? 'auto' },
  };
  return { config, warnings };
}

/** `readConfig()` without the warnings, for tests and tools. */
export function parseConfig(text: string, options: ConfigOptions = {}): AppConfig {
  return readConfig(text, options).config;
}

export interface LoadedConfig extends ParsedConfigResult {
  path: string;
  /** The raw file text, or null when no file exists (all defaults). */
  text: string | null;
}

export function loadConfigFile(path: string, options: Omit<ConfigOptions, 'source'> = {}): LoadedConfig {
  let text: string;
  try {
    if (statSync(path).isDirectory()) {
      throw new ConfigError(`${path} is a directory. Create the configuration file, for example with: cp config.example.yaml config.yaml`);
    }
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, text: null, ...readConfig('', options) };
    throw error;
  }
  return { path, text, ...readConfig(text, { ...options, source: path }) };
}
