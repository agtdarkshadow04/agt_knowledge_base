import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { parseConfig } from '../config.js';
import { lockedSettingKeys, setting, settingStates } from '../context.js';
import { SettingsService } from '../settings-service.js';
import { assertCalledWith, assertMatches, fakeDatabase, match, rejectsMatching } from './helpers.js';

type Query = (sql: string, params?: unknown[]) => Promise<unknown>;

const stored = new Map<string, unknown>([
  ['site.title', 'Dashboard Archive'],
  ['site.subtitle', 'Dashboard subtitle'],
  ['articles.defaultVisibility', 1],
  ['access.allowPublicBrowsing', false],
  ['backup.maxZipBytes', 52428800],
]);
const rows = [...stored].map(([key, value]) => ({ key, value }));

const database = {
  connect: mock.fn(async (): Promise<unknown> => undefined),
  query: mock.fn<Query>(async () => ({ rows })),
};

function service(configText: string) {
  return new SettingsService({ config: parseConfig(configText), db: fakeDatabase(database) });
}

/** A transaction client that stores writes in `table` and reads it back. */
function transaction(table: Map<string, unknown>) {
  const query = mock.fn<Query>(async (sql, params) => {
    if (sql.startsWith('INSERT INTO settings')) table.set(params![0] as string, JSON.parse(params![1] as string));
    if (sql.startsWith('DELETE FROM settings')) table.delete(params![0] as string);
    if (sql.startsWith('SELECT key, value FROM settings')) return { rows: [...table].map(([key, value]) => ({ key, value })) };
    return { rows: [] };
  });
  database.connect.mock.mockImplementation(async () => ({ query, release: mock.fn() }));
  return query;
}

describe('settings precedence (CFG-7)', () => {
  it('resolves each setting from the file, then the dashboard, then the default', () => {
    const config = parseConfig('site:\n  title: File Archive\nbackup:\n  maxEntries: 20\n');
    assert.deepEqual(setting(config, stored, 'site.title'), {
      key: 'site.title',
      value: 'File Archive',
      source: 'config',
      locked: true,
      default: 'AGT Knowledge Base',
      description: 'Name shown in the header and the browser title.',
    });
    assertMatches(setting(config, stored, 'site.subtitle'), { value: 'Dashboard subtitle', source: 'dashboard', locked: false });
    assertMatches(setting(config, stored, 'articles.defaultVisibility'), { value: 1, source: 'dashboard' });
    assertMatches(setting(config, stored, 'backup.maxZipBytes'), { value: 52428800, source: 'dashboard' });
    assertMatches(setting(config, stored, 'backup.maxEntries'), { value: 20, source: 'config', locked: true });
    assertMatches(setting(config, stored, 'backup.maxUncompressedBytes'), { value: 256 * 1024 * 1024, source: 'default', locked: false });
    assert.deepEqual(lockedSettingKeys(config), ['site.title', 'backup.maxEntries']);
    assert.deepEqual(settingStates(config, stored).map((state) => state.key), [
      'site.title', 'site.subtitle', 'site.supportUrl', 'articles.defaultVisibility',
      'access.allowPublicBrowsing', 'backup.maxZipBytes', 'backup.maxUncompressedBytes', 'backup.maxEntries',
    ]);
  });

  it('ignores a stored value its schema no longer allows', () => {
    assertMatches(setting(parseConfig(''), new Map([['backup.maxEntries', 0]]), 'backup.maxEntries'), { value: 16, source: 'default' });
  });

  it('a file value of false still locks the key', () => {
    assertMatches(setting(parseConfig('access:\n  allowPublicBrowsing: false\n'), new Map(), 'access.allowPublicBrowsing'), { value: false, source: 'config', locked: true });
  });
});

describe('SettingsService', () => {
  afterEach(() => {
    database.connect.mock.restore();
    database.connect.mock.resetCalls();
    database.query.mock.resetCalls();
  });

  it('serves the effective public values grouped by key (CFG-10)', async () => {
    assert.deepEqual(await service('access:\n  allowPublicBrowsing: true\n').getPublic(), {
      site: { title: 'Dashboard Archive', subtitle: 'Dashboard subtitle', supportUrl: 'https://www.nms-agt.com/support' },
      articles: { defaultVisibility: 1 },
      access: { allowPublicBrowsing: true },
    });
    assertCalledWith(database.query, 'SELECT key, value FROM settings');
  });

  it('serves the deprecated 1.x public body', async () => {
    assert.deepEqual(await service('').getLegacyPublic(), {
      applicationName: 'Dashboard Archive',
      applicationSubtitle: 'Dashboard subtitle',
      defaultVisibility: 1,
      allowPublicBrowsing: false,
      version: 1,
    });
  });

  it('returns the states and the deprecated 1.x view', async () => {
    const view = await service('site:\n  title: File Archive\n').getAdminView();
    assertMatches(view.states[0], { key: 'site.title', value: 'File Archive', source: 'config', locked: true });
    assert.equal(view.version, 1);
    assert.deepEqual(view.settings.applicationName, { key: 'site.title', value: 'File Archive', source: 'file' });
    assert.deepEqual(view.settings.backupMaxBytes, { key: 'backup.maxZipBytes', value: 52428800, source: 'dashboard' });
  });

  it('refuses the whole request if a key is set in config.yaml, before touching the database (CFG-8)', async () => {
    await rejectsMatching(service('articles:\n  defaultVisibility: 0\n').update({ values: { 'site.title': 'Renamed', 'articles.defaultVisibility': 2 } }), {
      statusCode: 409,
      error: 'defined_in_config',
      legacyCode: 'SETTING_DEFINED_IN_FILE',
      message: 'articles.defaultVisibility is defined in the configuration file and cannot be changed from the dashboard.',
      params: { key: 'articles.defaultVisibility' },
    });
    assert.equal(database.connect.mock.callCount(), 0);
  });

  it('refuses unknown keys and invalid values', async () => {
    await rejectsMatching(service('').update({ values: { 'site.title': 'Fine', 'server.port': 1 } }), { statusCode: 400, error: 'unknown_setting', params: { key: 'server.port' } });
    await rejectsMatching(service('').update({ values: { 'site.supportUrl': 'not a url' } }), { statusCode: 400, error: 'invalid_setting', params: { key: 'site.supportUrl' } });
    await rejectsMatching(service('').update({ values: { 'backup.maxZipBytes': 10 } }), { statusCode: 400, error: 'invalid_setting' });
    await rejectsMatching(service('').update({ values: { constructor: 1 } }), { statusCode: 400, error: 'unknown_setting' });
    assert.equal(database.connect.mock.callCount(), 0);
  });

  it('stores submitted values and resets null ones to the default', async () => {
    const table = new Map(stored);
    const query = transaction(table);
    const view = await service('').update({ values: { 'site.title': 'Renamed', 'backup.maxZipBytes': null } });
    assertCalledWith(query, match.stringContaining('INSERT INTO settings'), ['site.title', '"Renamed"']);
    assertCalledWith(query, 'DELETE FROM settings WHERE key = $1', ['backup.maxZipBytes']);
    assertCalledWith(query, 'COMMIT');
    assertMatches(view.states.find((state) => state.key === 'site.title'), { value: 'Renamed', source: 'dashboard' });
    assertMatches(view.states.find((state) => state.key === 'backup.maxZipBytes'), { value: 100 * 1024 * 1024, source: 'default' });
    assert.equal(table.get('site.subtitle'), 'Dashboard subtitle');
  });

  it('still accepts the deprecated 1.x body, mapping it to values', async () => {
    const table = new Map<string, unknown>();
    transaction(table);
    const view = await service('').update({ version: 4, applicationName: '  Renamed  ', backupMaxEntries: 40, backupMaxBytes: null });
    assert.deepEqual([...table], [['site.title', 'Renamed'], ['backup.maxEntries', 40]]);
    assertMatches(view.settings.applicationName, { value: 'Renamed', source: 'dashboard' });
    await rejectsMatching(service('').update({ version: 4, applicationName: null }), { statusCode: 400, error: 'invalid_setting' });
    await rejectsMatching(service('').update({ values: {}, applicationName: 'Both' }), { statusCode: 400, error: 'invalid_request' });
    await rejectsMatching(service('site:\n  title: File\n').update({ version: 4, applicationName: 'Renamed' }), { statusCode: 409, error: 'defined_in_config' });
  });

  it('rolls back when a write fails', async () => {
    const query = mock.fn<Query>(async (sql) => {
      if (sql.startsWith('INSERT')) throw new Error('write failed');
      return { rows: [] };
    });
    database.connect.mock.mockImplementation(async () => ({ query, release: mock.fn() }));
    await assert.rejects(service('').update({ values: { 'site.title': 'Renamed' } }), /write failed/);
    assertCalledWith(query, 'ROLLBACK');
  });
});
