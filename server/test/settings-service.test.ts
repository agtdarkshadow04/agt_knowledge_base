import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { parseConfig } from '../config.js';
import { fileDefinedSettings, resolveSettings, SettingsService } from '../settings-service.js';
import { assertCalledWith, assertMatches, fakeDatabase, match, rejectsMatching } from './helpers.js';

type Query = (sql: string, params?: unknown[]) => Promise<unknown>;

const database = {
  connect: mock.fn(async (): Promise<unknown> => undefined),
  query: mock.fn<Query>(async () => undefined),
};

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

function service(configText: string) {
  return new SettingsService({ config: parseConfig(configText), db: fakeDatabase(database) });
}

describe('settings precedence', () => {
  afterEach(() => {
    database.connect.mock.restore();
    database.connect.mock.resetCalls();
    database.query.mock.restore();
    database.query.mock.resetCalls();
  });

  it('resolves each setting from the file, then the dashboard, then the default', () => {
    const config = parseConfig('site:\n  applicationName: File Archive\nbackup:\n  maxEntries: 20\n');
    const view = resolveSettings(row, config);
    assert.equal(view.version, 4);
    assert.deepEqual(view.settings.applicationName, { key: 'site.applicationName', value: 'File Archive', source: 'file' });
    assert.deepEqual(view.settings.applicationSubtitle, { key: 'site.applicationSubtitle', value: 'Dashboard subtitle', source: 'dashboard' });
    assertMatches(view.settings.defaultVisibility, { value: 1, source: 'dashboard' });
    assert.deepEqual(view.settings.backupMaxBytes, { key: 'backup.maxBytes', value: 52428800, source: 'dashboard' });
    assertMatches(view.settings.backupMaxEntries, { value: 20, source: 'file' });
    assertMatches(view.settings.backupMaxUncompressedBytes, { value: 256 * 1024 * 1024, source: 'default' });
    assert.deepEqual(fileDefinedSettings(config), ['applicationName', 'backupMaxEntries']);
  });

  it('serves the effective values on the public settings route', async () => {
    database.query.mock.mockImplementation(async () => ({ rows: [row] }));
    assert.deepEqual(await service('access:\n  allowPublicBrowsing: true\n').getPublic(), {
      applicationName: 'Dashboard Archive',
      applicationSubtitle: 'Dashboard subtitle',
      defaultVisibility: 1,
      allowPublicBrowsing: true,
      version: 4,
    });
  });

  it('refuses to change a file-defined key before touching the database', async () => {
    await rejectsMatching(service('articles:\n  defaultVisibility: 0\n').update({ version: 4, applicationName: 'Renamed', defaultVisibility: 2 }), { statusCode: 409, code: 'SETTING_DEFINED_IN_FILE', message: match.stringContaining('articles.defaultVisibility') });
    assert.equal((database.connect).mock.callCount(), 0);
  });

  it('updates only submitted dashboard settings with optimistic concurrency', async () => {
    const query = mock.fn<Query>(async (sql) => {
      if (sql.includes('FOR UPDATE')) return { rows: [row] };
      if (sql.includes('UPDATE application_settings')) return { rows: [{ ...row, application_name: 'Renamed', backup_max_bytes: null, version: 5 }] };
      return { rows: [] };
    });
    database.connect.mock.mockImplementation(async () => ({ query, release: mock.fn() }));

    const view = await service('').update({ version: 4, applicationName: 'Renamed', backupMaxBytes: null });
    const update = query.mock.calls.find(({ arguments: [sql] }) => sql.includes('UPDATE application_settings'))!.arguments as [string, unknown[]];
    assert.ok((update[0]).includes('application_name = $1'));
    assert.ok((update[0]).includes('backup_max_bytes = $2'));
    assert.ok(!(update[0]).includes('application_subtitle ='));
    assert.deepEqual(update[1], ['Renamed', null]);
    assertMatches(view.settings.backupMaxBytes, { source: 'default', value: 100 * 1024 * 1024 });
    assert.equal(view.version, 5);
  });

  it('returns a version conflict for stale settings', async () => {
    const query = mock.fn<Query>(async (sql) => (sql.includes('FOR UPDATE') ? { rows: [row] } : { rows: [] }));
    database.connect.mock.mockImplementation(async () => ({ query, release: mock.fn() }));
    await rejectsMatching(service('').update({ version: 3, applicationName: 'Renamed' }), { statusCode: 409, code: 'VERSION_CONFLICT' });
    assertCalledWith(query, 'ROLLBACK');
  });
});
