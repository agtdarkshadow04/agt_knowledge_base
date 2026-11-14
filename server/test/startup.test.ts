import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseConfig } from '../config.js';
import { databaseSettings, envValue, loadStartup, StartupError } from '../startup.js';

function configFile(text: string) {
  const path = join(mkdtempSync(join(tmpdir(), 'agt-startup-')), 'config.yaml');
  writeFileSync(path, text);
  return path;
}

describe('environment variables (CFG-2)', () => {
  it('reads the AGT_KNOWLEDGE_BASE_ variables', () => {
    const startup = loadStartup({
      AGT_KNOWLEDGE_BASE_CONFIG_FILE: configFile('database:\n  user: kb\n  name: kb_data\n'),
      AGT_KNOWLEDGE_BASE_DB_PASSWORD: 'db-secret',
      AGT_KNOWLEDGE_BASE_DATABASE_HOST: 'db',
      AGT_KNOWLEDGE_BASE_SERVER_HOST: '0.0.0.0',
      AGT_KNOWLEDGE_BASE_SETUP_PASSWORD: 'setup-secret',
    });
    assert.deepEqual(startup.warnings, []);
    assert.equal(startup.setupPassword, 'setup-secret');
    assert.equal(startup.configFile.config.server.host, '0.0.0.0');
    assert.deepEqual(startup.database, { host: 'db', port: 5432, database: 'kb_data', user: 'kb', password: 'db-secret', ssl: false });
  });

  it('uses the defaults: ./config.yaml, localhost, agt_knowledge_base', () => {
    const startup = loadStartup({ AGT_KNOWLEDGE_BASE_DB_PASSWORD: 'db-secret', AGT_KNOWLEDGE_BASE_SETUP_PASSWORD: '' });
    assert.equal(startup.configFile.path, './config.yaml');
    assert.equal(startup.setupPassword, null);
    assert.deepEqual(startup.database, { host: 'localhost', port: 5432, database: 'agt_knowledge_base', user: 'agt_knowledge_base', password: 'db-secret', ssl: false });
  });

  it('lets config.yaml win over AGT_KNOWLEDGE_BASE_DATABASE_HOST', () => {
    const settings = databaseSettings(parseConfig('database:\n  host: from-file\n  ssl: true\n'), { AGT_KNOWLEDGE_BASE_DB_PASSWORD: 'x', AGT_KNOWLEDGE_BASE_DATABASE_HOST: 'from-env' }, []);
    assert.deepEqual(settings, { host: 'from-file', port: 5432, database: 'agt_knowledge_base', user: 'agt_knowledge_base', password: 'x', ssl: true });
  });

  it('requires the database password', () => {
    assert.throws(() => loadStartup({}), (error: unknown) => error instanceof StartupError && /AGT_KNOWLEDGE_BASE_DB_PASSWORD must be set/.test(error.message));
  });

  it('still accepts the 1.x variables until 3.0.0, with a warning for each (VER-10)', () => {
    const startup = loadStartup({
      CONFIG_FILE: configFile(''),
      AGT_SETUP_PASSWORD: 'old-setup',
      DB_HOST: 'postgres',
      DB_PORT: '5433',
      DB_NAME: 'old_db',
      DB_USER: 'postgres',
      DB_PASSWORD: 'old-secret',
      DATABASE_SSL: 'true',
      AUTH_MODE: 'local',
    });
    assert.equal(startup.setupPassword, 'old-setup');
    assert.deepEqual(startup.database, { host: 'postgres', port: 5433, database: 'old_db', user: 'postgres', password: 'old-secret', ssl: true });
    assert.equal(startup.warnings.length, 9);
    assert.ok(startup.warnings.includes('DB_USER is deprecated and will be removed in 3.0.0; set database.user in config.yaml.'));
    assert.ok(startup.warnings.includes('AGT_SETUP_PASSWORD is deprecated and will be removed in 3.0.0; rename it to AGT_KNOWLEDGE_BASE_SETUP_PASSWORD.'));
  });

  it('prefers the new names and config.yaml, so a 1.x variable that is not used gives no warning', () => {
    const startup = loadStartup({
      AGT_KNOWLEDGE_BASE_CONFIG_FILE: configFile('database:\n  user: kb\n'),
      AGT_KNOWLEDGE_BASE_DB_PASSWORD: 'new',
      DB_PASSWORD: 'old',
      DB_USER: 'postgres',
      DATABASE_URL: 'postgresql://ignored',
    });
    assert.deepEqual(startup.warnings, []);
    assert.deepEqual(startup.database, { host: 'localhost', port: 5432, database: 'agt_knowledge_base', user: 'kb', password: 'new', ssl: false });
  });

  it('accepts the deprecated DATABASE_URL when no new password is set', () => {
    const warnings: string[] = [];
    assert.deepEqual(databaseSettings(parseConfig(''), { DATABASE_URL: 'postgresql://u:p@h/d' }, warnings), { connectionString: 'postgresql://u:p@h/d', ssl: false });
    assert.match(warnings[0], /^DATABASE_URL is deprecated/);
  });

  it('refuses an invalid deprecated port and any AUTH_MODE but local', () => {
    assert.throws(() => databaseSettings(parseConfig(''), { AGT_KNOWLEDGE_BASE_DB_PASSWORD: 'x', DB_PORT: 'abc' }, []), /DB_PORT must be a port number/);
    assert.throws(() => loadStartup({ AUTH_MODE: 'cognito', AGT_KNOWLEDGE_BASE_DB_PASSWORD: 'x' }), /AUTH_MODE must be local or unset/);
  });

  it('reads an app variable or its 1.x name', () => {
    const warnings: string[] = [];
    assert.equal(envValue({ AGT_KNOWLEDGE_BASE_LOCAL_USER_PASSWORD: 'a', LOCAL_USER_PASSWORD: 'b' }, 'LOCAL_USER_PASSWORD', warnings, 'LOCAL_USER_PASSWORD'), 'a');
    assert.deepEqual(warnings, []);
    assert.equal(envValue({ LOCAL_USER_PASSWORD: 'b' }, 'LOCAL_USER_PASSWORD', warnings, 'LOCAL_USER_PASSWORD'), 'b');
    assert.equal(warnings.length, 1);
  });
});
