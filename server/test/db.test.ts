import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { settingKeys } from '../config.js';
import { CONTROL_MIGRATIONS, createDatabase, dataWriteScope, LOG_MIGRATIONS, lockKey, migrationId, MIGRATIONS, runMigrations, withTransaction } from '../db.js';
import { fakeDatabase, match, rejectsMatching } from './helpers.js';

type QueryFn = (sql: string, values?: unknown[]) => Promise<unknown>;

const byName = (name: string) => MIGRATIONS.find((migration) => migration.name === name)!;

/** A fake database for the runner: the role, the version table and what was applied. */
function fakeServer(options: {
  superuser?: boolean;
  columns?: string[];
  applied?: number[];
  controlApplied?: number[];
  logsApplied?: number[];
  failOn?: string;
  /** States `control.operation` reports, one per read; the last one repeats. */
  states?: string[];
  marker?: string;
} = {}) {
  const state = {
    columns: options.columns ?? ['version', 'name', 'applied_at'],
    applied: [...(options.applied ?? [])],
    controlApplied: [...(options.controlApplied ?? [])],
    logsApplied: [...(options.logsApplied ?? [])],
    states: [...(options.states ?? ['idle'])],
  };
  const versions = (list: number[]) => ({ rows: [...list].sort((a, b) => a - b).map((version) => ({ version })), rowCount: list.length });
  const query = mock.fn<QueryFn>(async (sql, values) => {
    if (options.failOn && sql === options.failOn) throw new Error('migration failed');
    if (sql.startsWith('SELECT rolsuper')) return { rows: [{ rolsuper: options.superuser ?? false }], rowCount: 1 };
    if (sql.includes('information_schema.columns')) return { rows: state.columns.map((column_name) => ({ column_name })), rowCount: state.columns.length };
    if (sql.startsWith('SELECT version FROM schema_migrations')) return versions(state.applied);
    if (sql.startsWith('SELECT version FROM control.schema_migrations')) return versions(state.controlApplied);
    if (sql.startsWith('SELECT version FROM logs.schema_migrations')) return versions(state.logsApplied);
    if (sql.startsWith('INSERT INTO logs.schema_migrations (version, name)')) state.logsApplied.push(values![0] as number);
    if (sql.startsWith('INSERT INTO schema_migrations (version, name)')) state.applied.push(values![0] as number);
    if (sql.startsWith('INSERT INTO control.schema_migrations (version, name)')) state.controlApplied.push(values![0] as number);
    if (sql.startsWith('SELECT state, pre_restore_backup FROM control.operation')) {
      return { rows: [{ state: state.states[0] === 'restore_failed' ? 'restore_failed' : 'idle', pre_restore_backup: 'pre-restore-backup-x.zip' }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT state FROM control.operation')) {
      const current = state.states.length > 1 ? state.states.shift()! : state.states[0];
      return { rows: [{ state: current }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: mock.fn() };
  const db = fakeDatabase({ connect: async () => client });
  const statements = () => query.mock.calls.map(({ arguments: [sql] }) => sql);
  return { db, client, state, statements };
}

describe('MIGRATIONS (DATA-3)', () => {
  it('lists every server/migrations/NNNN_<name>.sql file once, in order, numbered from 1', () => {
    const files = readdirSync('server/migrations').filter((file) => file.endsWith('.sql')).sort();
    assert.deepEqual(MIGRATIONS.map((migration) => `${String(migration.version).padStart(4, '0')}_${migration.name}.sql`), files);
    MIGRATIONS.forEach((migration, index) => {
      assert.equal(migration.version, index + 1);
      assert.equal(migration.sql, readFileSync(`server/migrations/${files[index]}`, 'utf8'), migration.name);
    });
  });

  it('keeps the 1.x ids that the deprecated preview field reports', () => {
    assert.equal(migrationId(MIGRATIONS[0]), '001_initial');
    assert.equal(migrationId(byName('auth_sessions')), '017_auth_sessions');
  });

  it('lists every server/migrations/control/NNNN_<name>.sql file in CONTROL_MIGRATIONS, the first exactly as BAK-12 gives it', () => {
    const files = readdirSync('server/migrations/control').filter((file) => file.endsWith('.sql')).sort();
    assert.deepEqual(CONTROL_MIGRATIONS.map((migration) => `${String(migration.version).padStart(4, '0')}_${migration.name}.sql`), files);
    const sql = CONTROL_MIGRATIONS[0].sql;
    assert.ok(sql.includes("state text NOT NULL CHECK (state IN ('idle', 'backup', 'restore', 'restore_failed'))"));
    assert.ok(sql.includes("INSERT INTO control.operation (id, state, generation) VALUES (1, 'idle', 0);"));
    for (const column of ['generation bigint NOT NULL', 'owner uuid', 'pre_restore_backup text', 'admin_session_hash text', 'admin_username text', 'admin_session_expires_at timestamptz']) {
      assert.ok(sql.includes(column), column);
    }
  });

  it('never schema-qualifies objects or sets search_path (DATA-11)', () => {
    for (const migration of MIGRATIONS) {
      assert.doesNotMatch(migration.sql, /\bpublic\./i, migration.name);
      assert.doesNotMatch(migration.sql, /search_path/i, migration.name);
    }
  });

  it('leaves no function, trigger, view or extension in the public schema (DATA-11)', () => {
    const all = MIGRATIONS.map((migration) => migration.sql).join('\n');
    for (const [, name] of all.matchAll(/CREATE (?:OR REPLACE )?FUNCTION ([a-z_]+)\(/g)) {
      assert.match(all, new RegExp(`DROP FUNCTION (?:IF EXISTS )?${name}\\(`), name);
    }
    for (const [, name] of all.matchAll(/CREATE TRIGGER ([a-z_]+)/g)) {
      assert.match(all, new RegExp(`DROP TRIGGER ${name} `), name);
    }
    assert.doesNotMatch(all, /CREATE (?:OR REPLACE )?VIEW/);
    assert.ok(byName('spec_storage').sql.includes('DROP EXTENSION pgcrypto'));
    assert.ok(byName('spec_storage').sql.indexOf('ALTER TABLE local_users ALTER COLUMN id DROP DEFAULT') < byName('spec_storage').sql.indexOf('DROP EXTENSION'));
  });

  it('gives tables text columns and created_at/updated_at (DATA-8, DATA-11)', () => {
    const sql = byName('spec_storage').sql;
    assert.ok(sql.includes('ALTER TABLE articles RENAME COLUMN modified_at TO updated_at'));
    for (const table of ['app_users', 'sessions', 'member_sessions']) {
      assert.ok(sql.includes(`ALTER TABLE ${table} ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now()`), table);
    }
    assert.ok(sql.includes('ADD CONSTRAINT articles_title_length CHECK (char_length(title) <= 180)'));
  });

  it('moves the super administrator to the admin table and renames member roles (0012)', () => {
    const sql = byName('admin_account').sql;
    assert.ok(sql.includes('CREATE TABLE admin ('));
    assert.ok(sql.indexOf('INSERT INTO admin (username, password_hash') < sql.indexOf('DELETE FROM local_users WHERE is_super_admin'));
    assert.ok(!sql.includes('DELETE FROM app_users'));
    assert.ok(sql.includes("CASE role WHEN 'Admin' THEN 'Moderator' ELSE 'Editor' END"));
  });

  it('copies changed 1.x settings and stores only EDITABLE_SETTINGS keys (0015)', () => {
    const sql = byName('settings_table').sql;
    assert.ok(sql.includes("('backup.maxZipBytes', to_jsonb(source.backup_max_bytes))"));
    const allowed = (migration: string) => byName(migration).sql.match(/CHECK \(key IN \(([^)]*)\)\)/)![1].match(/'[^']+'/g)!.map((key) => key.slice(1, -1));
    assert.deepEqual(allowed('settings_table'), settingKeys.filter((key) => !key.startsWith('logs.') && key !== 'iam.enabled'));
    // 0019 adds the LOG-16 retention settings, 0020 iam.enabled; the latest CHECK list is every EDITABLE_SETTINGS key.
    assert.deepEqual(allowed('log_settings'), settingKeys.filter((key) => key !== 'iam.enabled'));
    assert.deepEqual(allowed('agt_iam_members'), settingKeys);
    assert.ok(byName('drop_application_settings').sql.includes('DROP TABLE application_settings'));
  });

  it('rewrites 1.x password hashes and moves sessions (0017)', () => {
    const sql = byName('auth_sessions').sql;
    for (const table of ['admin', 'local_users']) {
      assert.match(sql, new RegExp(`UPDATE ${table}\\s+SET password_hash = 'scrypt\\$16384\\$8\\$1\\$'`), table);
    }
    assert.ok(sql.includes("translate(split_part(password_hash, '$', 2), '-_', '+/') || '==$'"));
    assert.ok(sql.indexOf('DELETE FROM admin_sessions') < sql.indexOf('ALTER TABLE admin_sessions RENAME TO sessions'));
    assert.ok(sql.includes('REFERENCES local_users (id) ON DELETE CASCADE'));
  });

});

describe('runMigrations (DATA-4, DATA-11)', () => {
  let server: ReturnType<typeof fakeServer>;
  beforeEach(() => { server = fakeServer(); });

  it('applies every migration on an empty database under the migration lock, each in its own transaction', async () => {
    server = fakeServer({ columns: [] });
    const result = await runMigrations(server.db);
    assert.deepEqual(result.applied, MIGRATIONS.map((migration) => migration.version));
    const sql = server.statements();
    const lock = sql.indexOf("SELECT pg_advisory_lock(0, hashtext('agt_knowledge_base_migrations'))");
    assert.ok(lock > sql.findIndex((statement) => statement.startsWith('SELECT rolsuper')));
    // BAK-12 startup: the control schema and its migrations first, under the migration lock.
    const controlSchema = sql.indexOf('CREATE SCHEMA IF NOT EXISTS control');
    assert.ok(controlSchema > lock);
    assert.ok(sql.indexOf(CONTROL_MIGRATIONS[0].sql) > controlSchema);
    // App migrations run while the write lock is held shared and the state is idle.
    const writeLock = sql.indexOf(`SELECT pg_advisory_lock_shared${lockKey('writes')}`);
    assert.ok(writeLock > sql.indexOf(CONTROL_MIGRATIONS[0].sql));
    assert.ok(sql.indexOf('SELECT state FROM control.operation WHERE id = 1') > writeLock);
    assert.ok(sql.findIndex((statement) => statement.startsWith('CREATE TABLE schema_migrations (')) > writeLock);
    assert.ok(sql.indexOf(`SELECT pg_advisory_unlock_shared${lockKey('writes')}`) > sql.indexOf(MIGRATIONS.at(-1)!.sql));
    // LOG-1: the log store's schema and migrations come after the control schema, before the app's.
    assert.ok(sql.indexOf('CREATE SCHEMA IF NOT EXISTS logs') > sql.indexOf(CONTROL_MIGRATIONS[0].sql));
    assert.ok(sql.indexOf(LOG_MIGRATIONS[0].sql) < writeLock);
    const all = MIGRATIONS.length + CONTROL_MIGRATIONS.length + LOG_MIGRATIONS.length;
    assert.equal(sql.filter((statement) => statement === 'BEGIN').length, all);
    assert.equal(sql.filter((statement) => statement === 'COMMIT').length, all);
    assert.equal(sql.at(-1), "SELECT pg_advisory_unlock(0, hashtext('agt_knowledge_base_migrations'))");
    assert.equal(server.client.release.mock.callCount(), 1);
    const insert = server.client.query.mock.calls.find(({ arguments: [statement] }) => statement.startsWith('INSERT INTO schema_migrations'))!;
    assert.deepEqual(insert.arguments[1], [1, 'initial']);
  });

  it('applies only pending migrations, including 1.x contract migrations that waited for an explicit target', async () => {
    const applied = MIGRATIONS.map((migration) => migration.version).filter((version) => ![7, 14, 16, 18].includes(version));
    server = fakeServer({ applied, controlApplied: [1] });
    assert.deepEqual((await runMigrations(server.db)).applied, [7, 14, 16, 18]);
    const sql = server.statements();
    assert.ok(sql.indexOf(byName('canonical_tags_contract').sql) < sql.indexOf(byName('spec_storage').sql));
  });

  it('converts the 1.x schema_migrations table to version, name and applied_at', async () => {
    server = fakeServer({ columns: ['id', 'applied_at'], applied: MIGRATIONS.map((migration) => migration.version) });
    await runMigrations(server.db);
    const sql = server.statements();
    assert.ok(sql.some((statement) => statement.includes("split_part(id, '_', 1)::integer, substr(id, strpos(id, '_') + 1), applied_at FROM schema_migrations")));
    assert.ok(sql.indexOf('ALTER TABLE schema_migrations_v2 RENAME TO schema_migrations') > sql.indexOf('DROP TABLE schema_migrations'));
  });

  it('refuses to start as a superuser, before taking the lock', async () => {
    server = fakeServer({ superuser: true });
    await rejectsMatching(runMigrations(server.db), { name: 'StartupCheckError', message: match.stringMatching(/superuser/) });
    assert.ok(!server.statements().some((statement) => statement.includes('pg_advisory_lock')));
    assert.equal(server.client.release.mock.callCount(), 1);
  });

  it('refuses a database whose schema is newer than this version (SRV-8)', async () => {
    server = fakeServer({ controlApplied: [1], logsApplied: [1], applied: [...MIGRATIONS.map((migration) => migration.version), MIGRATIONS.length + 1] });
    await rejectsMatching(runMigrations(server.db), { name: 'StartupCheckError', message: match.stringMatching(/newer than this version/) });
    assert.ok(!server.statements().includes('BEGIN'));
    assert.equal(server.statements().at(-1), "SELECT pg_advisory_unlock(0, hashtext('agt_knowledge_base_migrations'))");
  });

  it('rolls back a failing migration, records nothing for it and releases the lock', async () => {
    server = fakeServer({ controlApplied: [1], applied: MIGRATIONS.slice(0, -1).map((migration) => migration.version), failOn: MIGRATIONS.at(-1)!.sql });
    await assert.rejects(runMigrations(server.db), /migration failed/);
    assert.ok(server.statements().includes('ROLLBACK'));
    assert.ok(!server.state.applied.includes(MIGRATIONS.length));
    assert.equal(server.statements().at(-1), "SELECT pg_advisory_unlock(0, hashtext('agt_knowledge_base_migrations'))");
  });
});

describe('the BAK-12 startup steps', () => {
  it('refuses a log store newer than this version (SRV-8)', async () => {
    const server = fakeServer({ controlApplied: [1], logsApplied: [1, 2] });
    await rejectsMatching(runMigrations(server.db), { name: 'StartupCheckError', message: match.stringMatching(/log store is newer/) });
  });

  it('refuses a control schema newer than this version (SRV-8)', async () => {
    const server = fakeServer({ controlApplied: [1, 2] });
    await rejectsMatching(runMigrations(server.db), { name: 'StartupCheckError', message: match.stringMatching(/control schema is newer/) });
    assert.ok(!server.statements().some((statement) => statement.includes('pg_advisory_lock_shared')));
  });

  it('waits while a backup or restore runs, releasing the write lock between attempts', async () => {
    const server = fakeServer({ controlApplied: [1], applied: MIGRATIONS.map((migration) => migration.version), states: ['backup', 'restore', 'idle'] });
    const sleep = mock.fn(async (_milliseconds: number) => undefined);
    await runMigrations(server.db, { sleep });
    assert.equal(sleep.mock.callCount(), 2);
    const sql = server.statements();
    assert.equal(sql.filter((statement) => statement === `SELECT pg_advisory_lock_shared${lockKey('writes')}`).length, 3);
    assert.equal(sql.filter((statement) => statement === `SELECT pg_advisory_unlock_shared${lockKey('writes')}`).length, 3);
  });

  it('refuses to start after a failed restore, naming what is missing (BAK-11)', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'agt-marker-'));
    const marker = join(directory, 'restore-failed.json');
    try {
      const failedState = fakeServer({ controlApplied: [1], states: ['restore_failed'] });
      await rejectsMatching(runMigrations(failedState.db, { restoreFailedMarker: marker }), {
        name: 'StartupCheckError',
        message: match.stringMatching(/restore_failed.*marker file .* is missing.*pre-restore-backup-x\.zip.*README/),
      });
      assert.ok(!failedState.statements().some((statement) => statement.includes('pg_advisory_lock_shared')));

      writeFileSync(marker, '{}');
      const markerOnly = fakeServer({ controlApplied: [1] });
      await rejectsMatching(runMigrations(markerOnly.db, { restoreFailedMarker: marker }), {
        name: 'StartupCheckError',
        message: match.stringMatching(/marker file .* records a failed restore, but control\.operation is not restore_failed/),
      });
      const both = fakeServer({ controlApplied: [1], states: ['restore_failed'] });
      await rejectsMatching(runMigrations(both.db, { restoreFailedMarker: marker }), { message: match.stringMatching(/could not be rolled back/) });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe('data-write scope (BAK-12)', () => {
  it('runs a repository\'s own transaction as a savepoint on the write\'s client', async () => {
    const statements: string[] = [];
    const client = { query: mock.fn(async (sql: string) => { statements.push(sql); return { rows: [], rowCount: 0 }; }), release: mock.fn() };
    const db = createDatabase({ host: 'localhost', port: 5432, database: 'x', user: 'x', password: 'x', ssl: false });
    await dataWriteScope.run({ client: client as never }, async () => {
      await withTransaction(await db.pool(), async (inner) => { await inner.query('UPDATE tags SET name = $1', ['x']); });
      await assert.rejects(withTransaction(await db.pool(), async () => { throw new Error('conflict'); }), /conflict/);
      await (await db.pool()).query('SELECT 1');
    });
    assert.deepEqual(statements, [
      'SAVEPOINT data_write_1', 'UPDATE tags SET name = $1', 'RELEASE SAVEPOINT data_write_1',
      'SAVEPOINT data_write_1', 'ROLLBACK TO SAVEPOINT data_write_1', 'RELEASE SAVEPOINT data_write_1',
      'SELECT 1',
    ]);
    assert.equal(client.release.mock.callCount(), 0);
    await db.close();
  });
});

describe('withTransaction (DATA-11)', () => {
  function pool(failRollback = false) {
    const query = mock.fn<QueryFn>(async (sql) => {
      if (failRollback && sql === 'ROLLBACK') throw new Error('connection lost');
      return { rows: [], rowCount: 0 };
    });
    const client = { query, release: mock.fn((_error?: Error) => undefined) };
    return { pool: { connect: async () => client } as never, client };
  }

  it('commits and releases', async () => {
    const { pool: p, client } = pool();
    assert.equal(await withTransaction(p, async () => 'done'), 'done');
    assert.deepEqual(client.query.mock.calls.map(({ arguments: [sql] }) => sql), ['BEGIN', 'COMMIT']);
    assert.equal(client.release.mock.calls[0].arguments[0], undefined);
  });

  it('rolls back and releases on error, destroying a client whose rollback failed', async () => {
    const { pool: p, client } = pool();
    await assert.rejects(withTransaction(p, async () => { throw new Error('write failed'); }), /write failed/);
    assert.deepEqual(client.query.mock.calls.map(({ arguments: [sql] }) => sql), ['BEGIN', 'ROLLBACK']);
    assert.equal(client.release.mock.calls[0].arguments[0], undefined);

    const broken = pool(true);
    await assert.rejects(withTransaction(broken.pool, async () => { throw new Error('write failed'); }), /write failed/);
    assert.match(String(broken.client.release.mock.calls[0].arguments[0]), /connection lost/);
  });
});
