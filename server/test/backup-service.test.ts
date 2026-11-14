import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { buildBackupArchive, readBackupArchive, type BackupRow } from '../backup-archive.js';
import { BackupService, backupTables, unbackedTables, upgradePlan } from '../backup-service.js';
import { parseConfig, type AppConfig } from '../config.js';
import { migrations as schemaMigrations } from '../migrations.js';
import type { SettingsService } from '../settings-service.js';
import { assertMatches, fakeDatabase, match, rejectsMatching, testContext } from './helpers.js';

type QueryFn = (sql: string, params?: unknown[]) => Promise<unknown>;

const database = { connect: mock.fn(async (): Promise<unknown> => undefined) };

const current = schemaMigrations.filter((migration) => !migration.requiresExplicitTarget).map((migration) => migration.id);

const columns: Record<string, string[]> = {
  app_users: ['user_id', 'display_name'],
  local_users: ['id', 'username', 'role', 'is_active', 'session_version'],
  tags: ['id', 'name', 'color'],
  articles: ['id', 'title', 'tag_ids'],
  article_revisions: ['article_id', 'version'],
  application_settings: ['singleton', 'application_name', 'application_subtitle'],
  admin: ['id', 'username', 'password_hash'],
  admin_sessions: ['token_hash', 'expires_at'],
};

function tables(overrides: Record<string, BackupRow[]> = {}): Record<string, BackupRow[]> {
  return {
    app_users: [{ user_id: 'u1', display_name: 'Atlas' }],
    local_users: [{ id: 'l1', username: 'apollo', role: 'Editor', is_active: true, session_version: 3 }],
    tags: [],
    articles: [{ id: 'a1', title: 'Portal Guide', tag_ids: [] }],
    article_revisions: [{ article_id: 'a1', version: 1 }],
    application_settings: [{ singleton: true, application_name: 'Backup Archive', application_subtitle: 'From the backup' }],
    admin: [{ id: true, username: 'atlas', password_hash: 'scrypt$x$y' }],
    ...overrides,
  };
}

function archive(options: { migrations?: string[]; tables?: Record<string, BackupRow[]>; configText?: string | null } = {}) {
  return buildBackupArchive({
    appVersion: '1.0.0',
    createdAt: '2026-11-01T00:00:00.000Z',
    migrations: options.migrations ?? current,
    database: { tables: options.tables ?? tables() },
    configText: options.configText === undefined ? 'server:\n  port: 3001\n' : options.configText,
  });
}

interface FakeOptions {
  failOn?: (sql: string) => { code: string; message: string; table?: string; constraint?: string } | undefined;
}

function fakeClient(options: FakeOptions = {}) {
  const query = mock.fn<QueryFn>(async (sql, params) => {
    const failure = options.failOn?.(sql);
    if (failure) throw Object.assign(new Error(failure.message), failure);
    if (sql.startsWith('SELECT id FROM schema_migrations')) return { rows: current.map((id) => ({ id })) };
    if (sql.includes('current_schema()')) return { rows: [{ schema: 'public' }] };
    if (sql.includes('information_schema.columns')) {
      const only = params?.[1] as string[] | null;
      const rows = Object.entries(columns)
        .filter(([table]) => !only || only.includes(table))
        .flatMap(([table, names]) => [
          ...names.map((name) => ({ table_name: table, column_name: name, is_generated: 'NEVER' })),
          ...(table === 'articles' ? [{ table_name: table, column_name: 'search_vector', is_generated: 'ALWAYS' }] : []),
        ]);
      return { rows };
    }
    if (sql.includes('jsonb_agg')) {
      const table = /\."([a-z_]+)" source/.exec(sql)?.[1] ?? '';
      return { rows: [{ rows: tables()[table] ?? [] }] };
    }
    if (sql.includes('to_jsonb(settings)')) return { rows: [{ row: { application_name: 'Live Archive' } }] };
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: mock.fn() };
  database.connect.mock.mockImplementation(async () => client);
  return client;
}

function statements(client: ReturnType<typeof fakeClient>) {
  return client.query.mock.calls.map(({ arguments: [sql] }) => sql);
}

const settings = {
  getEffective: mock.fn(async () => ({ backupMaxBytes: 10 * 1024 * 1024, backupMaxEntries: 16, backupMaxUncompressedBytes: 10 * 1024 * 1024 })),
} as unknown as SettingsService;

let backupsDir: string;
let configDir: string;

let loaded: { path: string; text: string; config: AppConfig };

function useConfig(text: string, path = join(configDir, 'config.yaml')) {
  writeFileSync(path, text);
  const withStorage = `${text}\nstorage:\n  backupsDir: ${JSON.stringify(backupsDir)}\n`;
  loaded = { path, text, config: parseConfig(withStorage) };
}

function context() {
  return testContext({ config: loaded.config, configFile: { path: loaded.path, text: loaded.text }, db: fakeDatabase(database) });
}

function service() {
  return new BackupService(context(), settings, () => new Date('2026-11-07T06:15:00.123Z'));
}

describe('BackupService', () => {
  beforeEach(() => {
    backupsDir = join(mkdtempSync(join(tmpdir(), 'agt-backups-')), 'backups');
    configDir = mkdtempSync(join(tmpdir(), 'agt-config-'));
    useConfig('server:\n  port: 3001\n');
    database.connect.mock.restore();
    database.connect.mock.resetCalls();
  });

  it('covers every table the migrations create except Admin sessions', () => {
    const created = schemaMigrations.flatMap((migration) => [...migration.sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)]
      .map((match) => match[1]));
    assert.deepEqual([...new Set(created)].sort(), [...backupTables, ...unbackedTables].sort());
    assert.ok((backupTables).includes('admin'));
    assert.ok(!(backupTables as readonly string[]).includes('admin_sessions'));
  });

  it('exports a ZIP of every table from one read-only snapshot, with config.yaml and a manifest', async () => {
    const client = fakeClient();

    const result = await service().export();

    assert.equal(result.filename, 'agt-kb-backup-20261107-061500.zip');
    assert.equal(statements(client)[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const contents = await readBackupArchive(result.archive, { maxBytes: 1e8, maxEntries: 16, maxUncompressedBytes: 1e8 });
    assert.deepEqual(Object.keys(contents.database.tables), [...backupTables]);
    assert.ok(!('admin_sessions' in contents.database.tables));
    assertMatches(contents.manifest, { appVersion: match.any(String), migrations: current });
    assert.equal(contents.configText, 'server:\n  port: 3001\n');
    const articleDump = client.query.mock.calls.find(({ arguments: [sql] }) => sql.includes('"public"."articles" source'))!.arguments;
    assert.deepEqual(articleDump[1], [['search_vector']]);
  });

  it('previews without changing anything', async () => {
    const client = fakeClient();
    useConfig('server:\n  port: 4000\n');

    const preview = await service().preview(await archive());

    const sql = statements(client);
    assert.ok((sql).includes('ROLLBACK'));
    assert.ok(!(sql).includes('COMMIT'));
    assert.equal(sql.some((statement) => /TRUNCATE "public"/.test(statement)), false);
    assert.equal(sql.some((statement) => /INSERT INTO "public"/.test(statement)), false);
    assert.equal(existsSync(backupsDir), false);
    assertMatches(preview, {
      migrations: { backup: current, upgrade: [] },
      counts: { app_users: 1, local_users: 1, articles: 1, admin: 1 },
      config: { included: true, content: 'server:\n  port: 3001\n', identical: false },
      ignoredSettings: [],
    });
    assert.deepEqual(preview.config.diff, [
      { kind: ' ', text: 'server:' },
      { kind: '-', text: '  port: 4000' },
      { kind: '+', text: '  port: 3001' },
    ]);
  });

  it('builds the staging schema with a search_path that excludes the live schema', async () => {
    const client = fakeClient();
    await service().preview(await archive());
    const sql = statements(client);
    const create = sql.find((statement) => statement.startsWith('CREATE SCHEMA'))!;
    const staging = /"(kb_restore_[0-9a-f]{12})"/.exec(create)![1];
    assert.ok((sql).includes(`SET LOCAL search_path TO "${staging}"`));
    assert.equal(sql.filter((statement) => statement.startsWith('SET LOCAL search_path')).every((statement) => !statement.includes('public')), true);
    // Every migration of the backup's level runs after the search_path change and before rows load.
    const setPath = sql.indexOf(`SET LOCAL search_path TO "${staging}"`);
    const firstInsert = sql.findIndex((statement) => statement.startsWith(`INSERT INTO "${staging}"`));
    for (const migration of schemaMigrations.filter((candidate) => current.includes(candidate.id))) {
      const index = sql.indexOf(migration.sql);
      assert.ok(index > setPath, migration.id);
      assert.ok(index < firstInsert, migration.id);
    }
  });

  it('fails, rather than reaching a live table, when a migration refers to a table missing from staging', async () => {
    const last = schemaMigrations.find((migration) => migration.id === current.at(-1))!;
    const client = fakeClient({
      failOn: (sql) => (sql === last.sql ? { code: '42P01', message: 'relation "application_settings" does not exist' } : undefined),
    });

    await rejectsMatching(service().preview(await archive()), {
      statusCode: 400,
      error: 'invalid_backup', legacyCode: 'INVALID_BACKUP',
      message: match.stringContaining(`migration ${last.id} failed`),
    });
    assert.ok((statements(client)).includes('ROLLBACK'));
    assert.equal(statements(client).some((statement) => statement.includes('"public"') && /TRUNCATE|INSERT/.test(statement)), false);
  });

  it('upgrades an older backup with the remaining migrations after loading its rows', async () => {
    const client = fakeClient();
    const older = current.slice(0, -2);

    const preview = await service().preview(await archive({ migrations: older }));

    assert.deepEqual(preview.migrations.upgrade, current.slice(-2));
    const sql = statements(client);
    const lastInsert = sql.length - 1 - [...sql].reverse().findIndex((statement) => /^INSERT INTO "kb_restore_/.test(statement));
    for (const id of current.slice(-2)) {
      assert.ok((sql.indexOf(schemaMigrations.find((migration) => migration.id === id)!.sql)) > lastInsert);
    }
  });

  it('refuses newer, unknown, and diverging backups', async () => {
    assert.throws(() => upgradePlan([...current, '999_future'], current), /newer or different version/);
    assert.throws(() => upgradePlan(current, current.slice(0, -1)), /newer version/);
    assert.throws(() => upgradePlan(['001_initial', '003_article_pinning'], current), /diverges/);
    assert.deepEqual(upgradePlan(current.slice(0, 3), current), current.slice(3));
    assert.deepEqual(upgradePlan(current, current), []);

    const client = fakeClient();
    await rejectsMatching(service().restore(await archive({ migrations: [...current, '999_future'] })), { statusCode: 400, error: 'invalid_backup', legacyCode: 'INVALID_BACKUP' });
    assert.equal(statements(client).some((statement) => statement.startsWith('TRUNCATE "public"')), false);
  });

  it('writes a pre-restore backup, replaces every table, and signs everyone out', async () => {
    const client = fakeClient();

    const report = await service().restore(await archive());

    assert.match(report.preRestoreBackup, /^pre-restore-backup-20261107-061500-123-[0-9a-f]{6}\.zip$/);
    assert.deepEqual(readdirSync(backupsDir), [report.preRestoreBackup]);
    const sql = statements(client);
    const truncate = sql.find((statement) => statement.startsWith('TRUNCATE "public"'))!;
    for (const table of [...backupTables, 'admin_sessions']) assert.ok((truncate).includes(`"public"."${table}"`));
    const copies = sql.filter((statement) => /^INSERT INTO "public"/.test(statement));
    assert.deepEqual(copies.map((statement) => /INSERT INTO "public"\."([a-z_]+)"/.exec(statement)![1]), [...backupTables]);
    assert.ok(!copies.find((statement) => statement.includes('"articles"'))!.includes('search_vector'));
    const bump = sql.indexOf('UPDATE "public"."local_users" SET session_version = session_version + 1');
    assert.ok((bump) > sql.indexOf(truncate));
    assert.ok((sql.findIndex((statement) => statement.startsWith('DROP SCHEMA "kb_restore_'))) > bump);
    assert.equal(sql.at(-1), 'COMMIT');
  });

  it('never restores config.yaml', async () => {
    fakeClient();
    useConfig('server:\n  port: 4000\n');
    await service().restore(await archive({ configText: 'server:\n  port: 1\n' }));
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(join(configDir, 'config.yaml'), 'utf8'), 'server:\n  port: 4000\n');
  });

  it('keeps settings that config.yaml defines and lists them in the report', async () => {
    const client = fakeClient();
    useConfig('site:\n  applicationName: File Archive\n');

    const report = await service().restore(await archive());

    assert.deepEqual(report.ignoredSettings, ['site.applicationName']);
    const keep = client.query.mock.calls.find(({ arguments: [sql] }) => sql.startsWith('UPDATE "public"."application_settings"'))!.arguments;
    assert.ok((keep[0]).includes('SET ("application_name") = ('));
    assert.deepEqual(JSON.parse(String((keep[1] as unknown[])[0])), { application_name: 'Live Archive' });
  });

  it('aborts the restore when the pre-restore backup cannot be written', async () => {
    const client = fakeClient();
    writeFileSync(join(configDir, 'not-a-directory'), '');
    backupsDir = join(configDir, 'not-a-directory');
    useConfig('');
    const consoleError = mock.method(console, 'error', () => undefined);

    await rejectsMatching(service().restore(await archive()), { statusCode: 500, error: 'pre_restore_backup_failed', legacyCode: 'PRE_RESTORE_BACKUP_FAILED' });
    assert.equal(statements(client).some((statement) => statement.startsWith('CREATE SCHEMA') || statement.startsWith('TRUNCATE')), false);
    consoleError.mock.restore();
  });

  it('requires exactly one Admin and one settings row before touching the database', async () => {
    fakeClient();
    await rejectsMatching(service().preview(await archive({ tables: tables({ admin: [] }) })), { error: 'invalid_backup', legacyCode: 'INVALID_BACKUP', message: match.stringContaining('exactly one Admin') });
    await rejectsMatching(service().preview(await archive({ tables: tables({ application_settings: [] }) })), { error: 'invalid_backup', legacyCode: 'INVALID_BACKUP' });
    assert.equal((database.connect).mock.callCount(), 0);
  });

  it('rejects rows or tables that do not match the backup\'s schema version', async () => {
    fakeClient();
    await rejectsMatching(service().preview(await archive({ tables: tables({ tags: [{ id: 'x', name: 'Portal', color: '#FFFFFF', search_vector: 'x' }] }) })), { error: 'invalid_backup', legacyCode: 'INVALID_BACKUP', message: match.stringContaining('a row in tags does not match') });
    const { tags: _removed, ...withoutTags } = tables();
    void _removed;
    await rejectsMatching(service().preview(await archive({ tables: withoutTags })), { error: 'invalid_backup', legacyCode: 'INVALID_BACKUP', message: match.stringContaining('tables do not match') });
  });

  it('rolls back and reports constraint violations without echoing row values', async () => {
    const client = fakeClient({
      failOn: (sql) => (sql.startsWith('INSERT INTO "kb_restore_') && sql.includes('"articles"')
        ? { code: '23503', message: 'violates foreign key constraint (secret value)', table: 'articles', constraint: 'articles_created_by_fkey' }
        : undefined),
    });
    await rejectsMatching(service().restore(await archive()), {
      statusCode: 400,
      error: 'invalid_backup', legacyCode: 'INVALID_BACKUP',
      message: 'The backup cannot be restored: a row in articles violates the articles_created_by_fkey constraint.',
    });
    // The pre-restore export commits its own read-only snapshot; the restore transaction does not commit.
    const sql = statements(client);
    const restoreTransaction = sql.slice(sql.lastIndexOf('BEGIN'));
    assert.ok((restoreTransaction).includes('ROLLBACK'));
    assert.ok(!(restoreTransaction).includes('COMMIT'));
  });
});

describe('pre-restore backup retention', () => {
  function seed(names: string[]) {
    const directory = mkdtempSync(join(tmpdir(), 'agt-retention-'));
    for (const name of names) writeFileSync(join(directory, name), '');
    return directory;
  }

  const files = [
    'pre-restore-backup-20261101-000000-000.zip',
    'pre-restore-backup-20261102-000000-000.zip',
    'pre-restore-backup-20261103-000000-000.zip',
    'pre-restore-backup-20261104-000000-000.zip',
  ];

  it('keeps every pre-restore backup by default', async () => {
    const directory = seed([...files, 'agt-kb-backup-20261101-000000.zip']);
    await new BackupService(context(), settings).prunePreRestoreBackups(directory, files[3], undefined);
    assert.equal((readdirSync(directory)).length, 5);
  });

  it('prunes the oldest pre-restore backups beyond the configured number, never the new one', async () => {
    const directory = seed([...files, 'notes.txt']);
    await new BackupService(context(), settings).prunePreRestoreBackups(directory, files[3], 2);
    assert.deepEqual(readdirSync(directory).sort(), [files[2], files[3], 'notes.txt'].sort());

    // Even when the new file sorts first, it is kept.
    const other = seed(files);
    await new BackupService(context(), settings).prunePreRestoreBackups(other, files[0], 1);
    assert.deepEqual(readdirSync(other), [files[0]]);
  });
});
