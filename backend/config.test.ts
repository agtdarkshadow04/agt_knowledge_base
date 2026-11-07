// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfigFile, parseConfig } from './config.js';

describe('configuration file', () => {
  it('uses every default when the file is missing or empty', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agt-config-'));
    const missing = loadConfigFile(join(directory, 'config.yaml'));
    expect(missing.text).toBeNull();
    expect(missing.config).toEqual(parseConfig(''));
    expect(missing.config).toMatchObject({
      server: { host: '0.0.0.0', port: 3001, frontendOrigin: 'http://localhost:8080', trustProxy: false },
      session: { ttlHours: 12 },
      adminSession: { ttlHours: 12, secureCookie: 'auto' },
      rateLimits: { login: { max: 5, windowMinutes: 1 }, adminLogin: { max: 10, windowMinutes: 15 }, setup: { max: 10, windowMinutes: 15 } },
      storage: { backupsDir: '/app/data/backups' },
      backup: { preRestore: {} },
    });
    // Dashboard-editable keys stay unset so the dashboard value or default applies.
    expect(missing.config.site.applicationName).toBeUndefined();
    expect(missing.config.backup.maxBytes).toBeUndefined();
    expect(missing.config.backup.preRestore.keep).toBeUndefined();
  });

  it('reads and validates a file, filling in nested defaults', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agt-config-'));
    const path = join(directory, 'config.yaml');
    writeFileSync(path, 'server:\n  port: 4000\n  trustProxy: 1\nrateLimits:\n  login:\n    max: 3\nsite:\n  applicationName: Field Archive\n');
    const loaded = loadConfigFile(path);
    expect(loaded.text).toBe(readFileSync(path, 'utf8'));
    expect(loaded.config.server).toMatchObject({ port: 4000, trustProxy: 1, host: '0.0.0.0' });
    expect(loaded.config.rateLimits.login).toEqual({ max: 3, windowMinutes: 1 });
    expect(loaded.config.site.applicationName).toBe('Field Archive');
  });

  it('rejects unknown keys, naming them', () => {
    expect(() => parseConfig('server:\n  prot: 4000\n')).toThrow(ConfigError);
    expect(() => parseConfig('server:\n  prot: 4000\n')).toThrow('server.prot: unknown key');
    expect(() => parseConfig('backups:\n  dir: /tmp\n')).toThrow('backups: unknown key');
  });

  it('rejects invalid values, naming the key', () => {
    expect(() => parseConfig('server:\n  port: 70000\n')).toThrow(/server\.port/);
    expect(() => parseConfig('session:\n  ttlHours: 0\n')).toThrow(/session\.ttlHours/);
    expect(() => parseConfig('server:\n  frontendOrigin: https://kb.example.org/path\n')).toThrow(/server\.frontendOrigin/);
    expect(() => parseConfig('articles:\n  defaultVisibility: Secret\n')).toThrow(/articles\.defaultVisibility/);
    expect(() => parseConfig('backup:\n  maxBytes: 12\n')).toThrow(/backup\.maxBytes/);
    expect(() => parseConfig('adminSession:\n  secureCookie: maybe\n')).toThrow(/adminSession\.secureCookie/);
    expect(() => parseConfig('server: [1, 2\n')).toThrow(/not valid YAML/);
    expect(() => parseConfig('- just\n- a list\n')).toThrow(ConfigError);
  });

  it('explains a directory created by a missing bind mount', () => {
    const directory = mkdtempSync(join(tmpdir(), 'agt-config-'));
    mkdirSync(join(directory, 'config.yaml'));
    expect(() => loadConfigFile(join(directory, 'config.yaml'))).toThrow(/is a directory/);
  });

  it('documents a valid configuration in config.example.yaml', () => {
    const example = readFileSync(new URL('../config.example.yaml', import.meta.url), 'utf8');
    expect(() => parseConfig(example)).not.toThrow();
    // Uncommenting every documented key must still validate.
    const uncommented = example.split('\n').map((line) => line.replace(/^(\s*)# (\s*)(?=[a-zA-Z]+:)/, '$1$2')).join('\n');
    expect(() => parseConfig(uncommented)).not.toThrow();
    for (const key of ['frontendOrigin', 'trustProxy', 'ttlHours', 'secureCookie', 'adminLogin', 'adminPassword', 'backupsDir', 'maxBytes', 'maxEntries', 'maxUncompressedBytes', 'keep', 'applicationName', 'applicationSubtitle', 'defaultVisibility', 'allowPublicBrowsing']) {
      expect(example).toContain(`${key}:`);
    }
  });
});
