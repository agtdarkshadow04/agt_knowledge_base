import type pg from 'pg';
import type { AppConfig } from './config.js';
import type { AppContext } from './context.js';
import { HttpError } from './http.js';
import { type ApplicationSettings, type ArticleVisibility, type BackupLimits } from './domain.js';

/** Settings that can be set in config.yaml or edited in the admin dashboard. */
export interface DashboardSettings extends Omit<ApplicationSettings, 'version'>, BackupLimits {}
export type SettingName = keyof DashboardSettings;
export type SettingSource = 'file' | 'dashboard' | 'default';

export interface SettingView<T> {
  /** The configuration file key, e.g. `site.applicationName`. */
  key: string;
  value: T;
  source: SettingSource;
}

export interface AdminSettingsView {
  version: number;
  settings: { [Name in SettingName]: SettingView<DashboardSettings[Name]> };
}

export type SettingsWrite = { [Name in SettingName]?: DashboardSettings[Name] | null } & { version: number };

interface SettingDefinition {
  key: string;
  column: string;
  fromFile(config: AppConfig): unknown;
  fallback: unknown;
}

export const settingDefinitions: Record<SettingName, SettingDefinition> = {
  applicationName: {
    key: 'site.applicationName',
    column: 'application_name',
    fromFile: (config) => config.site.applicationName,
    fallback: 'AGT Knowledge Base',
  },
  applicationSubtitle: {
    key: 'site.applicationSubtitle',
    column: 'application_subtitle',
    fromFile: (config) => config.site.applicationSubtitle,
    fallback: 'Field-tested guides, community procedures, and traveller intelligence.',
  },
  defaultVisibility: {
    key: 'articles.defaultVisibility',
    column: 'default_visibility',
    fromFile: (config) => config.articles.defaultVisibility,
    fallback: 'Internal' satisfies ArticleVisibility,
  },
  allowPublicBrowsing: {
    key: 'access.allowPublicBrowsing',
    column: 'allow_public_browsing',
    fromFile: (config) => config.access.allowPublicBrowsing,
    fallback: true,
  },
  backupMaxBytes: {
    key: 'backup.maxBytes',
    column: 'backup_max_bytes',
    fromFile: (config) => config.backup.maxBytes,
    fallback: 100 * 1024 * 1024,
  },
  backupMaxEntries: {
    key: 'backup.maxEntries',
    column: 'backup_max_entries',
    fromFile: (config) => config.backup.maxEntries,
    fallback: 16,
  },
  backupMaxUncompressedBytes: {
    key: 'backup.maxUncompressedBytes',
    column: 'backup_max_uncompressed_bytes',
    fromFile: (config) => config.backup.maxUncompressedBytes,
    fallback: 256 * 1024 * 1024,
  },
};

export const settingNames = Object.keys(settingDefinitions) as SettingName[];

const columnList = [...settingNames.map((name) => settingDefinitions[name].column), 'version'].join(', ');

export type SettingsRow = Record<string, unknown> & { version: number };

/** Names of the settings config.yaml defines; they cannot be changed anywhere else. */
export function fileDefinedSettings(config: AppConfig) {
  return settingNames.filter((name) => settingDefinitions[name].fromFile(config) !== undefined);
}

function storedValue(name: SettingName, row: SettingsRow) {
  const value = row[settingDefinitions[name].column];
  if (value === null || value === undefined) return undefined;
  // pg returns bigint columns as strings.
  return typeof settingDefinitions[name].fallback === 'number' ? Number(value) : value;
}

/** Resolves a setting: config file, then the dashboard value, then the default. */
function resolve(name: SettingName, row: SettingsRow, config: AppConfig): SettingView<unknown> {
  const definition = settingDefinitions[name];
  const fromFile = definition.fromFile(config);
  if (fromFile !== undefined) return { key: definition.key, value: fromFile, source: 'file' };
  const stored = storedValue(name, row);
  if (stored !== undefined) return { key: definition.key, value: stored, source: 'dashboard' };
  return { key: definition.key, value: definition.fallback, source: 'default' };
}

export function resolveSettings(row: SettingsRow, config: AppConfig): AdminSettingsView {
  const settings = Object.fromEntries(settingNames.map((name) => [name, resolve(name, row, config)]));
  return { version: row.version, settings: settings as AdminSettingsView['settings'] };
}

function effective(view: AdminSettingsView): DashboardSettings {
  return Object.fromEntries(settingNames.map((name) => [name, view.settings[name].value])) as unknown as DashboardSettings;
}

function toDatabaseValue(name: SettingName, value: unknown) {
  return name === 'defaultVisibility' ? JSON.stringify(value) : value;
}

async function readRow(client: pg.Pool | pg.PoolClient, lock = false) {
  const result = await client.query<SettingsRow>(
    `SELECT ${columnList} FROM application_settings WHERE singleton = true${lock ? ' FOR UPDATE' : ''}`,
  );
  if (!result.rows[0]) throw new Error('Application settings are missing.');
  return result.rows[0];
}

export class SettingsService {
  constructor(private readonly context: Pick<AppContext, 'config' | 'db'>) {}

  /** The effective public settings, as served by `GET /settings`. */
  async getPublic(): Promise<ApplicationSettings> {
    const values = await this.getEffective();
    return {
      applicationName: values.applicationName,
      applicationSubtitle: values.applicationSubtitle,
      defaultVisibility: values.defaultVisibility,
      allowPublicBrowsing: values.allowPublicBrowsing,
      version: values.version,
    };
  }

  async getEffective(): Promise<DashboardSettings & { version: number }> {
    const view = await this.getAdminView();
    return { ...effective(view), version: view.version };
  }

  async getAdminView(): Promise<AdminSettingsView> {
    return resolveSettings(await readRow(await this.context.db.pool()), this.context.config);
  }

  /**
   * Saves the dashboard settings in the request. Settings the configuration
   * file defines are rejected with 409, naming the key, so the file always wins.
   */
  async update(input: SettingsWrite): Promise<AdminSettingsView> {
    const { config } = this.context;
    const fileDefined = new Set(fileDefinedSettings(config));
    const submitted = settingNames.filter((name) => input[name] !== undefined);
    const locked = submitted.find((name) => fileDefined.has(name));
    if (locked) {
      const key = settingDefinitions[locked].key;
      throw new HttpError(409, 'defined_in_config', `${key} is set in the configuration file and cannot be changed here.`, {
        params: { key },
        legacyCode: 'SETTING_DEFINED_IN_FILE',
      });
    }
    for (const name of submitted) {
      if (input[name] === null && typeof settingDefinitions[name].fallback !== 'number') {
        throw new HttpError(400, 'invalid_setting', `${settingDefinitions[name].key} cannot be cleared.`);
      }
    }

    const pool = await this.context.db.pool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await readRow(client, true);
      if (current.version !== input.version) {
        throw new HttpError(409, 'conflict', 'Application settings changed after you opened them. Reload and try again.', { legacyCode: 'VERSION_CONFLICT' });
      }
      const assignments = submitted.map((name, index) => {
        const cast = name === 'defaultVisibility' ? '::jsonb' : '';
        return `${settingDefinitions[name].column} = $${index + 1}${cast}`;
      });
      const result = await client.query<SettingsRow>(
        `UPDATE application_settings
         SET ${[...assignments, 'version = version + 1', 'updated_at = now()'].join(', ')}
         WHERE singleton = true
         RETURNING ${columnList}`,
        submitted.map((name) => toDatabaseValue(name, input[name])),
      );
      await client.query('COMMIT');
      return resolveSettings(result.rows[0], config);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
