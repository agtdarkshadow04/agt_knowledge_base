import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertMatches } from './helpers.js';
import { ConfigError, configValue, EDITABLE_SETTINGS, loadConfigFile, parseConfig, readConfig, settingKeys, validSetting } from '../config.js';

describe('configuration file (CFG-3, CFG-5)', () => {
  it('uses every default when the file is missing or empty', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agt-config-'));
    const missing = loadConfigFile(join(directory, 'config.yaml'));
    assert.equal(missing.text, null);
    assert.deepEqual(missing.warnings, []);
    assert.deepEqual(missing.config, parseConfig(''));
    assertMatches(missing.config, {
      server: { host: '127.0.0.1', port: 8081, trustProxy: false, logLevel: 'info' },
      storage: { dataDir: 'data', backupsDir: 'backups' },
      database: { previewName: 'agt_knowledge_base_preview' },
      session: { ttlHours: 12, secureCookie: 'auto' },
      rateLimits: {
        login: { max: 10, windowMinutes: 15 },
        setup: { max: 10, windowMinutes: 15 },
        adminUploads: { max: 120, windowMinutes: 15 },
      },
      backup: { preRestore: {} },
    });
    // Dashboard-editable keys stay unset so the dashboard value or default applies.
    for (const key of settingKeys) assert.equal(configValue(missing.config, key), undefined, key);
    // So do the database keys, which fall back to the environment, and the deprecated keys.
    assert.equal(missing.config.database.host, undefined);
    assert.equal(missing.config.database.user, undefined);
    assert.equal(missing.config.server.frontendOrigin, undefined);
    assert.equal(missing.config.rateLimits.adminLogin, undefined);
    assert.equal(missing.config.adminSession.ttlHours, undefined);
  });

  it('reads and validates a file, filling in nested defaults', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agt-config-'));
    const path = join(directory, 'config.yaml');
    writeFileSync(path, 'server:\n  port: 4000\n  trustProxy: 10.0.0.0/8\nrateLimits:\n  login:\n    max: 3\nsite:\n  title: Field Archive\n');
    const loaded = loadConfigFile(path);
    assert.equal(loaded.text, readFileSync(path, 'utf8'));
    assertMatches(loaded.config.server, { port: 4000, trustProxy: '10.0.0.0/8', host: '127.0.0.1' });
    assert.deepEqual(loaded.config.rateLimits.login, { max: 3, windowMinutes: 15 });
    assert.equal(loaded.config.site.title, 'Field Archive');
  });

  it('takes server.host from the launcher when the file does not set it (CFG-2)', () => {
    assert.equal(parseConfig('', { defaultHost: '0.0.0.0' }).server.host, '0.0.0.0');
    assert.equal(parseConfig('server:\n  host: 192.0.2.1\n', { defaultHost: '0.0.0.0' }).server.host, '192.0.2.1');
  });

  it('accepts every trustProxy form', () => {
    for (const value of ['true', 'false', '1', '127.0.0.1', '[10.0.0.0/8, 192.168.0.1]']) {
      assert.doesNotThrow(() => parseConfig(`server:\n  trustProxy: ${value}\n`), value);
    }
  });

  it('rejects unknown keys, naming them', () => {
    assert.throws(() => parseConfig('server:\n  prot: 4000\n'), ConfigError);
    assert.throws(() => parseConfig('server:\n  prot: 4000\n', { source: 'config.yaml' }), /^ConfigError: Invalid config\.yaml: server\.prot: Unexpected property$/);
    assert.throws(() => parseConfig('backups:\n  dir: /tmp\n'), /backups: Unexpected property/);
  });

  it('rejects invalid values, naming the key', () => {
    assert.throws(() => parseConfig('server:\n  port: 70000\n'), /server\.port/);
    assert.throws(() => parseConfig('server:\n  logLevel: loud\n'), /server\.logLevel/);
    assert.throws(() => parseConfig('session:\n  ttlHours: 0\n'), /session\.ttlHours/);
    assert.throws(() => parseConfig('session:\n  secureCookie: maybe\n'), /session\.secureCookie/);
    assert.throws(() => parseConfig('server:\n  frontendOrigin: https://kb.example.org/path\n'), /server\.frontendOrigin/);
    assert.throws(() => parseConfig('articles:\n  defaultVisibility: Secret\n'), /articles\.defaultVisibility/);
    assert.throws(() => parseConfig('backup:\n  maxZipBytes: 12\n'), /backup\.maxZipBytes/);
    assert.throws(() => parseConfig('site:\n  title: "   "\n'), /site\.title/);
    assert.throws(() => parseConfig('site:\n  supportUrl: javascript:alert(1)\n'), /site\.supportUrl/);
    assert.throws(() => parseConfig('database:\n  port: "5432"\n'), /database\.port/);
    assert.throws(() => parseConfig('server: [1, 2\n'), /not valid YAML/);
    assert.throws(() => parseConfig('- just\n- a list\n'), ConfigError);
  });

  it('accepts the 1.x key names until 3.0.0, with a warning for each (VER-10)', () => {
    const { config, warnings } = readConfig([
      'site:',
      '  applicationName: Old Name',
      '  applicationSubtitle: Old subtitle',
      'backup:',
      '  maxBytes: 2097152',
      'adminSession:',
      '  ttlHours: 4',
      '  secureCookie: true',
      'rateLimits:',
      '  adminLogin: { max: 3, windowMinutes: 5 }',
      'server:',
      '  frontendOrigin: https://kb.example.org',
    ].join('\n'), { source: 'config.yaml' });
    assertMatches(config, {
      site: { title: 'Old Name', subtitle: 'Old subtitle' },
      backup: { maxZipBytes: 2097152 },
      session: { secureCookie: true, ttlHours: 12 },
      adminSession: { ttlHours: 4 },
      rateLimits: { adminLogin: { max: 3, windowMinutes: 5 } },
      server: { frontendOrigin: 'https://kb.example.org' },
    });
    assert.equal(warnings.length, 7);
    assert.ok(warnings.includes('config.yaml: site.applicationName is deprecated and will be removed in 3.0.0; rename it to site.title.'));
    assert.ok(warnings.some((warning) => warning.startsWith('config.yaml: rateLimits.adminLogin is deprecated')));
  });

  it('refuses a 1.x key next to its new name', () => {
    assert.throws(() => parseConfig('site:\n  title: New\n  applicationName: Old\n'), /site\.applicationName: deprecated name of site\.title/);
  });

  it('validates a renamed key with the new key\'s schema', () => {
    assert.throws(() => parseConfig('backup:\n  maxBytes: 12\n'), /backup\.maxZipBytes/);
  });

  it('explains a directory created by a missing bind mount', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agt-config-'));
    mkdirSync(join(directory, 'config.yaml'));
    assert.throws(() => loadConfigFile(join(directory, 'config.yaml')), /is a directory/);
  });

  it('documents every key in config.example.yaml (CFG-4)', () => {
    const example = readFileSync('config.example.yaml', 'utf8');
    assert.deepEqual(readConfig(example).warnings, []);
    // Uncommenting every documented key must still validate, without deprecated keys.
    const uncommented = example.split('\n').map((line) => line.replace(/^(\s*)# (\s*)(?=[a-zA-Z]+:)/, '$1$2')).join('\n');
    const result = readConfig(uncommented);
    assert.deepEqual(result.warnings, []);
    for (const key of settingKeys) assert.notEqual(configValue(result.config, key), undefined, `${key} is not documented`);
    for (const key of ['host', 'port', 'trustProxy', 'logLevel', 'dataDir', 'backupsDir', 'previewName', 'user', 'ssl', 'ttlHours', 'secureCookie', 'login', 'setup', 'adminUploads', 'keep']) {
      assert.ok(example.includes(`${key}:`), key);
    }
    assert.match(example, /\.env/);
    assert.match(example, /wins/);
  });
});

describe('EDITABLE_SETTINGS (CFG-6)', () => {
  it('has a schema, a valid default and a description for every key', () => {
    for (const key of settingKeys) {
      const definition = EDITABLE_SETTINGS[key];
      assert.ok(validSetting(key, definition.default), key);
      assert.ok(definition.description.length > 0, key);
    }
  });

  it('enforces the allowed values', () => {
    assert.ok(validSetting('site.title', 'A'));
    assert.ok(!validSetting('site.title', ''));
    assert.ok(!validSetting('site.title', 'x'.repeat(101)));
    assert.ok(validSetting('site.supportUrl', 'https://example.org/help?q=1'));
    assert.ok(!validSetting('site.supportUrl', 'ftp://example.org'));
    assert.ok(!validSetting('site.supportUrl', '/relative'));
    assert.ok(validSetting('articles.defaultVisibility', 3));
    assert.ok(!validSetting('articles.defaultVisibility', 6));
    assert.ok(!validSetting('access.allowPublicBrowsing', 'yes'));
    assert.ok(!validSetting('backup.maxZipBytes', 10));
    assert.ok(!validSetting('backup.maxUncompressedBytes', 600 * 1024 * 1024));
    assert.ok(!validSetting('backup.maxEntries', 1.5));
  });
});
