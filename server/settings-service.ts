import type pg from 'pg';
import { EDITABLE_SETTINGS, isSettingKey, validSetting, type SettingKey, type SettingValues } from './config.js';
import {
  lockedSettingKeys,
  settingStates,
  settingValues,
  type AppContext,
  type SettingState,
  type StoredSettings,
} from './context.js';
import type { ArticleVisibility } from './domain.js';
import { HttpError } from './http.js';

/** The settings the public UI needs, from `GET /api/settings/public` (CFG-10). */
export interface PublicSettings {
  site: { title: string; subtitle: string; supportUrl: string };
  articles: { defaultVisibility: ArticleVisibility };
  access: { allowPublicBrowsing: boolean };
}

/** The 1.x names of the dashboard settings, used by the deprecated request and response fields until 3.0.0. */
export const legacySettingNames = {
  applicationName: 'site.title',
  applicationSubtitle: 'site.subtitle',
  defaultVisibility: 'articles.defaultVisibility',
  allowPublicBrowsing: 'access.allowPublicBrowsing',
  backupMaxBytes: 'backup.maxZipBytes',
  backupMaxEntries: 'backup.maxEntries',
  backupMaxUncompressedBytes: 'backup.maxUncompressedBytes',
} as const satisfies Record<string, SettingKey>;

export type LegacySettingName = keyof typeof legacySettingNames;
const legacyNames = Object.keys(legacySettingNames) as LegacySettingName[];

/** `GET`/`PUT /api/admin/settings`: `states` (CFG-7), plus the deprecated 1.x `version` and `settings`. */
export interface AdminSettingsView {
  states: SettingState[];
  /** Deprecated: always 1; settings no longer carry a version. */
  version: number;
  /** Deprecated: the states by 1.x name, with `source: 'file'` for `config`. */
  settings: Record<LegacySettingName, { key: string; value: unknown; source: 'file' | 'dashboard' | 'default' }>;
}

/** `PUT /api/admin/settings`: `values` (CFG-8), or the deprecated 1.x fields with a `version`. */
export type SettingsWrite = { values?: Record<string, unknown>; version?: number } & { [Name in LegacySettingName]?: unknown };

/** The deprecated `GET /api/settings` body. */
export interface LegacyPublicSettings {
  applicationName: string;
  applicationSubtitle: string;
  defaultVisibility: ArticleVisibility;
  allowPublicBrowsing: boolean;
  version: number;
}

function toView(states: SettingState[]): AdminSettingsView {
  const byKey = new Map(states.map((state) => [state.key, state]));
  const settings = Object.fromEntries(legacyNames.map((name) => {
    const state = byKey.get(legacySettingNames[name])!;
    return [name, { key: state.key, value: state.value, source: state.source === 'config' ? 'file' : state.source }];
  })) as AdminSettingsView['settings'];
  return { states, version: 1, settings };
}

/** Turns a deprecated 1.x settings write into `values`. */
function legacyValues(input: SettingsWrite): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const name of legacyNames) {
    const value = input[name];
    if (value === undefined) continue;
    // 1.x accepted null only for the backup limits.
    if (value === null && !legacySettingNames[name].startsWith('backup.')) {
      throw new HttpError(400, 'invalid_setting', `${legacySettingNames[name]} cannot be cleared.`, { params: { key: legacySettingNames[name] } });
    }
    values[legacySettingNames[name]] = typeof value === 'string' && !name.startsWith('backup') ? value.trim() : value;
  }
  return values;
}

async function readStored(client: pg.Pool | pg.PoolClient): Promise<StoredSettings> {
  const result = await client.query<{ key: string; value: unknown }>('SELECT key, value FROM settings');
  return new Map(result.rows.map((row) => [row.key, row.value]));
}

export class SettingsService {
  constructor(private readonly context: Pick<AppContext, 'config' | 'db'>) {}

  async states(): Promise<SettingState[]> {
    return settingStates(this.context.config, await readStored(await this.context.db.pool()));
  }

  /** The effective value of every setting, by key. */
  async values(): Promise<SettingValues> {
    return settingValues(this.context.config, await readStored(await this.context.db.pool()));
  }

  async getAdminView(): Promise<AdminSettingsView> {
    return toView(await this.states());
  }

  async getPublic(): Promise<PublicSettings> {
    const values = await this.values();
    return {
      site: { title: values['site.title'], subtitle: values['site.subtitle'], supportUrl: values['site.supportUrl'] },
      articles: { defaultVisibility: values['articles.defaultVisibility'] },
      access: { allowPublicBrowsing: values['access.allowPublicBrowsing'] },
    };
  }

  async getLegacyPublic(): Promise<LegacyPublicSettings> {
    const values = await this.values();
    return {
      applicationName: values['site.title'],
      applicationSubtitle: values['site.subtitle'],
      defaultVisibility: values['articles.defaultVisibility'],
      allowPublicBrowsing: values['access.allowPublicBrowsing'],
      version: 1,
    };
  }

  /**
   * Applies `{ values: { key: value | null } }` (CFG-8): `null` resets a key to
   * its default. The whole request is refused when any key is unknown
   * (`400 unknown_setting`), set in config.yaml (`409 defined_in_config`) or
   * not allowed by its schema (`400 invalid_setting`).
   */
  async update(input: SettingsWrite): Promise<AdminSettingsView> {
    const usesLegacy = legacyNames.some((name) => input[name] !== undefined);
    if (input.values !== undefined && (usesLegacy || input.version !== undefined)) {
      throw new HttpError(400, 'invalid_request', 'Send either values or the deprecated 1.x fields, not both.');
    }
    const values = input.values ?? legacyValues(input);
    const keys = Object.keys(values);

    const unknown = keys.find((key) => !isSettingKey(key));
    if (unknown !== undefined) {
      throw new HttpError(400, 'unknown_setting', `${unknown} is not a dashboard setting.`, { params: { key: unknown } });
    }
    const locked = new Set<string>(lockedSettingKeys(this.context.config));
    const lockedKey = keys.find((key) => locked.has(key));
    if (lockedKey !== undefined) {
      throw new HttpError(409, 'defined_in_config', `${lockedKey} is defined in the configuration file and cannot be changed from the dashboard.`, {
        params: { key: lockedKey },
        legacyCode: 'SETTING_DEFINED_IN_FILE',
      });
    }
    const invalid = (keys as SettingKey[]).find((key) => values[key] !== null && !validSetting(key, values[key]));
    if (invalid !== undefined) {
      throw new HttpError(400, 'invalid_setting', `${invalid}: ${EDITABLE_SETTINGS[invalid].description}`, { params: { key: invalid } });
    }

    const pool = await this.context.db.pool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      for (const key of keys) {
        if (values[key] === null) {
          await client.query('DELETE FROM settings WHERE key = $1', [key]);
        } else {
          await client.query(
            `INSERT INTO settings (key, value) VALUES ($1, $2::jsonb)
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [key, JSON.stringify(values[key])],
          );
        }
      }
      const stored = await readStored(client);
      await client.query('COMMIT');
      return toView(settingStates(this.context.config, stored));
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
