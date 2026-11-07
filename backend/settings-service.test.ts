// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({ connect: vi.fn(), query: vi.fn() }));
vi.mock('./db.js', () => ({ getPool: vi.fn(async () => database) }));

import { parseConfig, setConfigForTests } from './config.js';
import { fileDefinedSettings, resolveSettings, SettingsService } from './settings-service.js';

const row = {
  application_name: 'Dashboard Archive',
  application_subtitle: 'Dashboard subtitle',
  default_visibility: 1,
  allow_public_browsing: false,
  backup_max_bytes: '52428800',
  backup_max_entries: null,
  backup_max_uncompressed_bytes: null,
  version: 4,
};

function useConfig(text: string) {
  setConfigForTests({ path: '/app/config.yaml', text, config: parseConfig(text) });
}

describe('settings precedence', () => {
  afterEach(() => {
    setConfigForTests(undefined);
    database.connect.mockReset();
    database.query.mockReset();
  });

  it('resolves each setting from the file, then the dashboard, then the default', () => {
    const config = parseConfig('site:\n  applicationName: File Archive\nbackup:\n  maxEntries: 20\n');
    const view = resolveSettings(row, config);
    expect(view.version).toBe(4);
    expect(view.settings.applicationName).toEqual({ key: 'site.applicationName', value: 'File Archive', source: 'file' });
    expect(view.settings.applicationSubtitle).toEqual({ key: 'site.applicationSubtitle', value: 'Dashboard subtitle', source: 'dashboard' });
    expect(view.settings.defaultVisibility).toMatchObject({ value: 1, source: 'dashboard' });
    expect(view.settings.backupMaxBytes).toEqual({ key: 'backup.maxBytes', value: 52428800, source: 'dashboard' });
    expect(view.settings.backupMaxEntries).toMatchObject({ value: 20, source: 'file' });
    expect(view.settings.backupMaxUncompressedBytes).toMatchObject({ value: 256 * 1024 * 1024, source: 'default' });
    expect(fileDefinedSettings(config)).toEqual(['applicationName', 'backupMaxEntries']);
  });

  it('serves the effective values on the public settings route', async () => {
    useConfig('access:\n  allowPublicBrowsing: true\n');
    database.query.mockResolvedValue({ rows: [row] });
    await expect(new SettingsService().getPublic()).resolves.toEqual({
      applicationName: 'Dashboard Archive',
      applicationSubtitle: 'Dashboard subtitle',
      defaultVisibility: 1,
      allowPublicBrowsing: true,
      version: 4,
    });
  });

  it('refuses to change a file-defined key before touching the database', async () => {
    useConfig('articles:\n  defaultVisibility: 0\n');
    await expect(new SettingsService().update({ version: 4, applicationName: 'Renamed', defaultVisibility: 2 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'SETTING_DEFINED_IN_FILE', message: expect.stringContaining('articles.defaultVisibility') });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('updates only submitted dashboard settings with optimistic concurrency', async () => {
    useConfig('');
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('FOR UPDATE')) return { rows: [row] };
      if (sql.includes('UPDATE application_settings')) return { rows: [{ ...row, application_name: 'Renamed', backup_max_bytes: null, version: 5 }] };
      return { rows: [] };
    });
    database.connect.mockResolvedValue({ query, release: vi.fn() });

    const view = await new SettingsService().update({ version: 4, applicationName: 'Renamed', backupMaxBytes: null });
    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE application_settings')) as unknown as [string, unknown[]];
    expect(update[0]).toContain('application_name = $1');
    expect(update[0]).toContain('backup_max_bytes = $2');
    expect(update[0]).not.toContain('application_subtitle =');
    expect(update[1]).toEqual(['Renamed', null]);
    expect(view.settings.backupMaxBytes).toMatchObject({ source: 'default', value: 100 * 1024 * 1024 });
    expect(view.version).toBe(5);
  });

  it('returns a version conflict for stale settings', async () => {
    useConfig('');
    const query = vi.fn(async (sql: string) => (sql.includes('FOR UPDATE') ? { rows: [row] } : { rows: [] }));
    database.connect.mockResolvedValue({ query, release: vi.fn() });
    await expect(new SettingsService().update({ version: 3, applicationName: 'Renamed' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'VERSION_CONFLICT' });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });
});
