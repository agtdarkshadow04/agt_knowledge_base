import {
  configValue,
  EDITABLE_SETTINGS,
  settingKeys,
  validSetting,
  type AppConfig,
  type SettingKey,
  type SettingValues,
} from './config.js';
import type { Database } from './db.js';

/**
 * Everything the routes and services need, built once by `server/index.ts`
 * (SRV-1, SRV-3). Nothing else reads the environment or the config file.
 */
export interface AppContext {
  /** The validated `config.yaml`, with defaults applied. Never changes at runtime. */
  readonly config: AppConfig;
  /** The configuration file as read at startup; backups copy its text, restores never write it. */
  readonly configFile: { readonly path: string; readonly text: string | null };
  readonly db: Database;
  /** `AGT_KNOWLEDGE_BASE_SETUP_PASSWORD`, or null when it is unset or empty. */
  readonly setupPassword: string | null;
  /** `LOCAL_AUTH_SECRET`, which signs member tokens. */
  readonly localAuthSecret: string;
  /** The app version from `package.json`. */
  readonly version: string;
}

export type SettingSource = 'config' | 'dashboard' | 'default';

/** One dashboard setting and where its effective value comes from (CFG-7). */
export interface SettingState<Key extends SettingKey = SettingKey> {
  key: Key;
  value: SettingValues[Key];
  source: SettingSource;
  /** Set in config.yaml, so it cannot be changed from the dashboard. */
  locked: boolean;
  default: SettingValues[Key];
  description: string;
}

/** Values stored in the `settings` table, by key. */
export type StoredSettings = ReadonlyMap<string, unknown>;

/**
 * The effective value of one setting: config file, then dashboard, then
 * default (CFG-7). This and `settingStates()` are the only place precedence is
 * decided. A stored value the schema no longer allows is ignored.
 */
export function setting<Key extends SettingKey>(config: AppConfig, stored: StoredSettings, key: Key): SettingState<Key> {
  const definition = EDITABLE_SETTINGS[key];
  const base = { key, default: definition.default as SettingValues[Key], description: definition.description };
  const fromFile = configValue(config, key);
  if (fromFile !== undefined) return { ...base, value: fromFile as SettingValues[Key], source: 'config', locked: true };
  const fromDashboard = stored.get(key);
  if (fromDashboard !== undefined && validSetting(key, fromDashboard)) {
    return { ...base, value: fromDashboard as SettingValues[Key], source: 'dashboard', locked: false };
  }
  return { ...base, value: base.default, source: 'default', locked: false };
}

/** Every setting in `EDITABLE_SETTINGS` order. */
export function settingStates(config: AppConfig, stored: StoredSettings): SettingState[] {
  return settingKeys.map((key) => setting(config, stored, key));
}

/** The effective values of every setting, by key. */
export function settingValues(config: AppConfig, stored: StoredSettings): SettingValues {
  return Object.fromEntries(settingStates(config, stored).map((state) => [state.key, state.value])) as SettingValues;
}

/** Keys config.yaml sets; no API, migration or restore may change them (CFG-8). */
export function lockedSettingKeys(config: AppConfig): SettingKey[] {
  return settingKeys.filter((key) => configValue(config, key) !== undefined);
}
