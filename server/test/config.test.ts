import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertMatches } from './helpers.js';
import { ConfigError, loadConfigFile, parseConfig } from '../config.js';

describe('configuration file', () => {
  it('uses every default when the file is missing or empty', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agt-config-'));
    const missing = loadConfigFile(join(directory, 'config.yaml'));
    assert.equal(missing.text, null);
    assert.deepEqual(missing.config, parseConfig(''));
    assertMatches(missing.config, {
      server: { host: '0.0.0.0', port: 3001, frontendOrigin: 'http://localhost:8080', trustProxy: false },
      session: { ttlHours: 12 },
      adminSession: { ttlHours: 12, secureCookie: 'auto' },
      rateLimits: { login: { max: 5, windowMinutes: 1 }, adminLogin: { max: 10, windowMinutes: 15 }, setup: { max: 10, windowMinutes: 15 } },
      storage: { backupsDir: '/app/data/backups' },
      backup: { preRestore: {} },
    });
    // Dashboard-editable keys stay unset so the dashboard value or default applies.
    assert.equal(missing.config.site.applicationName, undefined);
    assert.equal(missing.config.backup.maxBytes, undefined);
    assert.equal(missing.config.backup.preRestore.keep, undefined);
  });

  it('reads and validates a file, filling in nested defaults', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agt-config-'));
    const path = join(directory, 'config.yaml');
    writeFileSync(path, 'server:\n  port: 4000\n  trustProxy: 1\nrateLimits:\n  login:\n    max: 3\nsite:\n  applicationName: Field Archive\n');
    const loaded = loadConfigFile(path);
    assert.equal(loaded.text, readFileSync(path, 'utf8'));
    assertMatches(loaded.config.server, { port: 4000, trustProxy: 1, host: '0.0.0.0' });
    assert.deepEqual(loaded.config.rateLimits.login, { max: 3, windowMinutes: 1 });
    assert.equal(loaded.config.site.applicationName, 'Field Archive');
  });

  it('rejects unknown keys, naming them', () => {
    assert.throws(() => parseConfig('server:\n  prot: 4000\n'), ConfigError);
    assert.throws(() => parseConfig('server:\n  prot: 4000\n'), /server\.prot: unknown key/);
    assert.throws(() => parseConfig('backups:\n  dir: /tmp\n'), /backups: unknown key/);
  });

  it('rejects invalid values, naming the key', () => {
    assert.throws(() => parseConfig('server:\n  port: 70000\n'), /server\.port/);
    assert.throws(() => parseConfig('session:\n  ttlHours: 0\n'), /session\.ttlHours/);
    assert.throws(() => parseConfig('server:\n  frontendOrigin: https://kb.example.org/path\n'), /server\.frontendOrigin/);
    assert.throws(() => parseConfig('articles:\n  defaultVisibility: Secret\n'), /articles\.defaultVisibility/);
    assert.throws(() => parseConfig('backup:\n  maxBytes: 12\n'), /backup\.maxBytes/);
    assert.throws(() => parseConfig('adminSession:\n  secureCookie: maybe\n'), /adminSession\.secureCookie/);
    assert.throws(() => parseConfig('server: [1, 2\n'), /not valid YAML/);
    assert.throws(() => parseConfig('- just\n- a list\n'), ConfigError);
  });

  it('explains a directory created by a missing bind mount', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agt-config-'));
    mkdirSync(join(directory, 'config.yaml'));
    assert.throws(() => loadConfigFile(join(directory, 'config.yaml')), /is a directory/);
  });

  it('documents a valid configuration in config.example.yaml', () => {
    const example = readFileSync('config.example.yaml', 'utf8');
    assert.doesNotThrow(() => parseConfig(example));
    // Uncommenting every documented key must still validate.
    const uncommented = example.split('\n').map((line) => line.replace(/^(\s*)# (\s*)(?=[a-zA-Z]+:)/, '$1$2')).join('\n');
    assert.doesNotThrow(() => parseConfig(uncommented));
    for (const key of ['frontendOrigin', 'trustProxy', 'ttlHours', 'secureCookie', 'adminLogin', 'adminPassword', 'backupsDir', 'maxBytes', 'maxEntries', 'maxUncompressedBytes', 'keep', 'applicationName', 'applicationSubtitle', 'defaultVisibility', 'allowPublicBrowsing']) {
      assert.ok((example).includes(`${key}:`));
    }
  });
});
