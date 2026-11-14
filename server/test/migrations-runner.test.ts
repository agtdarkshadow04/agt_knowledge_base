import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { applyMigrationSql, runMigrations as run, type MigrationOptions } from '../migrations-runner.js';
import { migrations } from '../migrations.js';
import { assertCalledWith, fakeDatabase } from './helpers.js';

type QueryFn = (sql: string, values?: string[]) => Promise<unknown>;

const database = {
  applied: new Set<string>(),
  client: {
    query: mock.fn<QueryFn>(async () => undefined),
    release: mock.fn(),
  },
  connect: mock.fn(async (): Promise<unknown> => undefined),
};

const runMigrations = (options?: MigrationOptions) => run(fakeDatabase({ connect: database.connect }), options);

const expansion = migrations.find((migration) => migration.id === '006_canonical_tags_expand')!;
const contract = migrations.find((migration) => migration.id === '007_canonical_tags_contract')!;
const localAuth = migrations.find((migration) => migration.id === '008_local_auth')!;
const admin = migrations.find((migration) => migration.id === '009_admin')!;
const agtVisibility = migrations.find((migration) => migration.id === '010_agt_visibility')!;
const renameUserKey = migrations.find((migration) => migration.id === '011_rename_user_key')!;
const adminAccount = migrations.find((migration) => migration.id === '012_admin_account')!;
const backupLimits = migrations.find((migration) => migration.id === '013_backup_limit_settings')!;
const adminContract = migrations.find((migration) => migration.id === '014_admin_account_contract')!;
const defaultLevel = ['008_local_auth', '009_admin', '010_agt_visibility', '011_rename_user_key', '012_admin_account', '013_backup_limit_settings'];

describe('targeted migrations', () => {
  beforeEach(() => {
    database.applied = new Set(migrations.slice(0, 5).map((migration) => migration.id));
    database.client.release.mock.resetCalls();
    database.client.query.mock.resetCalls();
    database.client.query.mock.mockImplementation(async (sql, values) => {
      if (sql.startsWith('SELECT 1 FROM schema_migrations')) {
        return { rowCount: database.applied.has(values?.[0] ?? '') ? 1 : 0, rows: [] };
      }
      if (sql.startsWith('INSERT INTO schema_migrations')) database.applied.add(values?.[0] ?? '');
      return { rowCount: 0, rows: [] };
    });
    database.connect.mock.resetCalls();
    database.connect.mock.mockImplementation(async () => database.client);
  });

  it('stops after the requested expansion migration', async () => {
    assert.deepEqual(await runMigrations({ targetId: '006_canonical_tags_expand' }), {
      applied: ['006_canonical_tags_expand'],
    });

    const executedSql = database.client.query.mock.calls.map(({ arguments: [sql] }) => sql);
    assert.ok((executedSql).includes(expansion.sql));
    assert.ok(!(executedSql).includes(contract.sql));
    assert.ok(!(executedSql).includes(localAuth.sql));
    assert.equal((database.client.release).mock.callCount(), 1);
  });

  it('does not apply an explicit-only contract migration by default', async () => {
    assert.deepEqual(await runMigrations(), {
      applied: ['006_canonical_tags_expand', ...defaultLevel],
    });

    const executedSql = database.client.query.mock.calls.map(({ arguments: [sql] }) => sql);
    assert.ok((executedSql).includes(expansion.sql));
    assert.ok(!(executedSql).includes(contract.sql));
    assert.ok((executedSql).includes(localAuth.sql));
    assert.ok((executedSql).includes(admin.sql));
    assert.ok((executedSql).includes(agtVisibility.sql));
  });

  it('does not advance past an already-applied target', async () => {
    database.applied.add('006_canonical_tags_expand');

    assert.deepEqual(await runMigrations({ targetId: '006_canonical_tags_expand' }), { applied: [] });
    assert.ok(!(database.client.query.mock.calls.map(({ arguments: [sql] }) => sql)).includes(contract.sql));
  });

  it('applies the contract only when it is explicitly targeted', async () => {
    database.applied.add('006_canonical_tags_expand');

    assert.deepEqual(await runMigrations({ targetId: '007_canonical_tags_contract' }), {
      applied: ['007_canonical_tags_contract'],
    });
    assert.ok((database.client.query.mock.calls.map(({ arguments: [sql] }) => sql)).includes(contract.sql));
    assert.ok(!(database.client.query.mock.calls.map(({ arguments: [sql] }) => sql)).includes(localAuth.sql));
  });

  it('recognizes an already-applied explicit migration during default runs', async () => {
    database.applied.add('006_canonical_tags_expand');
    database.applied.add('007_canonical_tags_contract');

    assert.deepEqual(await runMigrations(), { applied: defaultLevel });
    assertCalledWith(database.client.query, 'SELECT 1 FROM schema_migrations WHERE id = $1',
      ['007_canonical_tags_contract'],);
  });

  it('can target a later migration without applying an explicit-only migration', async () => {
    database.applied.add('006_canonical_tags_expand');

    assert.deepEqual(await runMigrations({ targetId: '008_local_auth' }), {
      applied: ['008_local_auth'],
    });
    const executedSql = database.client.query.mock.calls.map(({ arguments: [sql] }) => sql);
    assert.ok(!(executedSql).includes(contract.sql));
    assert.ok((executedSql).includes(localAuth.sql));
  });

  it('can target the admin migration without applying the explicit-only contract', async () => {
    database.applied.add('006_canonical_tags_expand');
    database.applied.add('008_local_auth');

    assert.deepEqual(await runMigrations({ targetId: '009_admin' }), { applied: ['009_admin'] });
    const executedSql = database.client.query.mock.calls.map(({ arguments: [sql] }) => sql);
    assert.ok(!(executedSql).includes(contract.sql));
    assert.ok((executedSql).includes(admin.sql));
    assert.ok(!(executedSql).includes(agtVisibility.sql));
  });

  it('migrates legacy visibility text to JSON strings before accepting numeric levels', async () => {
    database.applied.add('006_canonical_tags_expand');
    database.applied.add('008_local_auth');
    database.applied.add('009_admin');

    assert.deepEqual(await runMigrations({ targetId: '010_agt_visibility' }), { applied: ['010_agt_visibility'] });
    assert.ok((agtVisibility.sql).includes('TYPE jsonb USING to_jsonb(visibility)'));
    assert.ok((agtVisibility.sql).includes(`visibility IN ('"Public"'::jsonb, '"Internal"'::jsonb, '"Admin"'::jsonb)`));
    assert.ok((agtVisibility.sql).includes(`visibility IN ('0'::jsonb, '1'::jsonb, '2'::jsonb, '3'::jsonb, '4'::jsonb, '5'::jsonb)`));
  });

  it('renames the user key by default without applying the explicit-only contract', async () => {
    for (const id of ['006_canonical_tags_expand', '008_local_auth', '009_admin', '010_agt_visibility']) database.applied.add(id);

    assert.deepEqual(await runMigrations(), { applied: ['011_rename_user_key', '012_admin_account', '013_backup_limit_settings'] });
    assert.ok(!(renameUserKey.requiresExplicitTarget));
    assert.ok((renameUserKey.sql).includes('ALTER TABLE app_users RENAME COLUMN cognito_sub TO user_id'));
    assert.ok(!(database.client.query.mock.calls.map(({ arguments: [sql] }) => sql)).includes(contract.sql));
  });

  it('moves the super administrator to the admin table and renames member roles by default', async () => {
    for (const id of ['006_canonical_tags_expand', '008_local_auth', '009_admin', '010_agt_visibility', '011_rename_user_key']) database.applied.add(id);

    assert.deepEqual(await runMigrations(), { applied: ['012_admin_account', '013_backup_limit_settings'] });
    assert.ok(!(adminAccount.requiresExplicitTarget));
    const sql = adminAccount.sql;
    assert.ok((sql).includes('CREATE TABLE admin ('));
    assert.ok((sql).includes('id boolean PRIMARY KEY DEFAULT true CHECK (id)'));
    assert.ok((sql).includes('CREATE TABLE admin_sessions ('));
    // Credentials are copied before the row is removed from local_users, and
    // the user_id is left in app_users so authorship is kept.
    assert.ok((sql.indexOf('INSERT INTO admin (username, password_hash')) < sql.indexOf('DELETE FROM local_users WHERE is_super_admin'));
    assert.ok(!(sql).includes('DELETE FROM app_users'));
    assert.ok((sql).includes("CASE role WHEN 'Admin' THEN 'Moderator' ELSE 'Editor' END"));
    assert.ok((sql).includes('session_version = session_version + 1'));
    assert.ok((sql).includes("CHECK (role IN ('Editor', 'Moderator'))"));
    assert.ok((backupLimits.sql).includes('ADD COLUMN backup_max_bytes bigint'));
    const executed = database.client.query.mock.calls.map(({ arguments: [statement] }) => statement);
    assert.ok(!(executed).includes(adminContract.sql));
  });

  it('drops the super-administrator column only when the contract is explicitly targeted', async () => {
    for (const id of ['006_canonical_tags_expand', ...defaultLevel]) database.applied.add(id);
    assert.equal(adminContract.requiresExplicitTarget, true);
    assert.deepEqual(await runMigrations(), { applied: [] });
    assert.deepEqual(await runMigrations({ targetId: '014_admin_account_contract' }), { applied: ['014_admin_account_contract'] });
    assert.ok((adminContract.sql).includes('ALTER TABLE local_users DROP COLUMN is_super_admin'));
  });

  it('keeps reviewable SQL copies of the inline migrations', () => {
    for (const migration of [adminAccount, backupLimits, adminContract]) {
      const file = readFileSync(`migrations/${migration.id}.sql`, 'utf8');
      assert.equal(file.startsWith('BEGIN;'), true);
      assert.equal(file.trimEnd().endsWith('COMMIT;'), true);
      for (const statement of migration.sql.split(';').map((part) => part.trim().split('\n')[0]).filter(Boolean)) {
        assert.ok((file).includes(statement));
      }
    }
  });

  it('never schema-qualifies objects, so restore can replay migrations in a staging schema', () => {
    for (const migration of migrations) {
      assert.doesNotMatch(migration.sql, /\bpublic\./i, migration.id);
      assert.doesNotMatch(migration.sql, /search_path/i, migration.id);
    }
  });

  it('replays migration SQL on an open transaction without recording it', async () => {
    const client = { query: mock.fn(async (_sql: string) => ({ rows: [] })) };
    await applyMigrationSql(client, ['001_initial', '002_article_revisions']);
    assert.deepEqual(client.query.mock.calls.map(({ arguments: [sql] }) => sql), [migrations[0].sql, migrations[1].sql]);
    await assert.rejects(applyMigrationSql(client, ['999_unknown']), /Unknown migration 999_unknown\./);
  });

  it('rejects unknown targets before opening a database connection', async () => {
    await assert.rejects(runMigrations({ targetId: 'not-a-migration' }), /targetId must name a known migration\./);
    assert.equal((database.connect).mock.callCount(), 0);
  });
});
