// @vitest-environment node
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  applied: new Set<string>(),
  client: {
    query: vi.fn(),
    release: vi.fn(),
  },
  connect: vi.fn(),
}));

vi.mock('./db.js', () => ({
  getPool: vi.fn(async () => ({ connect: database.connect })),
}));

import { applyMigrationSql, runMigrations } from './migrations-runner.js';
import { migrations } from './migrations.js';

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
    database.client.release.mockReset();
    database.client.query.mockReset();
    database.client.query.mockImplementation(async (sql: string, values?: string[]) => {
      if (sql.startsWith('SELECT 1 FROM schema_migrations')) {
        return { rowCount: database.applied.has(values?.[0] ?? '') ? 1 : 0, rows: [] };
      }
      if (sql.startsWith('INSERT INTO schema_migrations')) database.applied.add(values?.[0] ?? '');
      return { rowCount: 0, rows: [] };
    });
    database.connect.mockReset();
    database.connect.mockResolvedValue(database.client);
  });

  it('stops after the requested expansion migration', async () => {
    await expect(runMigrations({ targetId: '006_canonical_tags_expand' })).resolves.toEqual({
      applied: ['006_canonical_tags_expand'],
    });

    const executedSql = database.client.query.mock.calls.map(([sql]) => sql);
    expect(executedSql).toContain(expansion.sql);
    expect(executedSql).not.toContain(contract.sql);
    expect(executedSql).not.toContain(localAuth.sql);
    expect(database.client.release).toHaveBeenCalledOnce();
  });

  it('does not apply an explicit-only contract migration by default', async () => {
    await expect(runMigrations()).resolves.toEqual({
      applied: ['006_canonical_tags_expand', ...defaultLevel],
    });

    const executedSql = database.client.query.mock.calls.map(([sql]) => sql);
    expect(executedSql).toContain(expansion.sql);
    expect(executedSql).not.toContain(contract.sql);
    expect(executedSql).toContain(localAuth.sql);
    expect(executedSql).toContain(admin.sql);
    expect(executedSql).toContain(agtVisibility.sql);
  });

  it('does not advance past an already-applied target', async () => {
    database.applied.add('006_canonical_tags_expand');

    await expect(runMigrations({ targetId: '006_canonical_tags_expand' })).resolves.toEqual({ applied: [] });
    expect(database.client.query.mock.calls.map(([sql]) => sql)).not.toContain(contract.sql);
  });

  it('applies the contract only when it is explicitly targeted', async () => {
    database.applied.add('006_canonical_tags_expand');

    await expect(runMigrations({ targetId: '007_canonical_tags_contract' })).resolves.toEqual({
      applied: ['007_canonical_tags_contract'],
    });
    expect(database.client.query.mock.calls.map(([sql]) => sql)).toContain(contract.sql);
    expect(database.client.query.mock.calls.map(([sql]) => sql)).not.toContain(localAuth.sql);
  });

  it('recognizes an already-applied explicit migration during default runs', async () => {
    database.applied.add('006_canonical_tags_expand');
    database.applied.add('007_canonical_tags_contract');

    await expect(runMigrations()).resolves.toEqual({ applied: defaultLevel });
    expect(database.client.query).toHaveBeenCalledWith(
      'SELECT 1 FROM schema_migrations WHERE id = $1',
      ['007_canonical_tags_contract'],
    );
  });

  it('can target a later migration without applying an explicit-only migration', async () => {
    database.applied.add('006_canonical_tags_expand');

    await expect(runMigrations({ targetId: '008_local_auth' })).resolves.toEqual({
      applied: ['008_local_auth'],
    });
    const executedSql = database.client.query.mock.calls.map(([sql]) => sql);
    expect(executedSql).not.toContain(contract.sql);
    expect(executedSql).toContain(localAuth.sql);
  });

  it('can target the admin migration without applying the explicit-only contract', async () => {
    database.applied.add('006_canonical_tags_expand');
    database.applied.add('008_local_auth');

    await expect(runMigrations({ targetId: '009_admin' })).resolves.toEqual({ applied: ['009_admin'] });
    const executedSql = database.client.query.mock.calls.map(([sql]) => sql);
    expect(executedSql).not.toContain(contract.sql);
    expect(executedSql).toContain(admin.sql);
    expect(executedSql).not.toContain(agtVisibility.sql);
  });

  it('migrates legacy visibility text to JSON strings before accepting numeric levels', async () => {
    database.applied.add('006_canonical_tags_expand');
    database.applied.add('008_local_auth');
    database.applied.add('009_admin');

    await expect(runMigrations({ targetId: '010_agt_visibility' })).resolves.toEqual({ applied: ['010_agt_visibility'] });
    expect(agtVisibility.sql).toContain('TYPE jsonb USING to_jsonb(visibility)');
    expect(agtVisibility.sql).toContain(`visibility IN ('"Public"'::jsonb, '"Internal"'::jsonb, '"Admin"'::jsonb)`);
    expect(agtVisibility.sql).toContain(`visibility IN ('0'::jsonb, '1'::jsonb, '2'::jsonb, '3'::jsonb, '4'::jsonb, '5'::jsonb)`);
  });

  it('renames the user key by default without applying the explicit-only contract', async () => {
    for (const id of ['006_canonical_tags_expand', '008_local_auth', '009_admin', '010_agt_visibility']) database.applied.add(id);

    await expect(runMigrations()).resolves.toEqual({ applied: ['011_rename_user_key', '012_admin_account', '013_backup_limit_settings'] });
    expect(renameUserKey.requiresExplicitTarget).toBeFalsy();
    expect(renameUserKey.sql).toContain('ALTER TABLE app_users RENAME COLUMN cognito_sub TO user_id');
    expect(database.client.query.mock.calls.map(([sql]) => sql)).not.toContain(contract.sql);
  });

  it('moves the super administrator to the admin table and renames member roles by default', async () => {
    for (const id of ['006_canonical_tags_expand', '008_local_auth', '009_admin', '010_agt_visibility', '011_rename_user_key']) database.applied.add(id);

    await expect(runMigrations()).resolves.toEqual({ applied: ['012_admin_account', '013_backup_limit_settings'] });
    expect(adminAccount.requiresExplicitTarget).toBeFalsy();
    const sql = adminAccount.sql;
    expect(sql).toContain('CREATE TABLE admin (');
    expect(sql).toContain('id boolean PRIMARY KEY DEFAULT true CHECK (id)');
    expect(sql).toContain('CREATE TABLE admin_sessions (');
    // Credentials are copied before the row is removed from local_users, and
    // the user_id is left in app_users so authorship is kept.
    expect(sql.indexOf('INSERT INTO admin (username, password_hash')).toBeLessThan(sql.indexOf('DELETE FROM local_users WHERE is_super_admin'));
    expect(sql).not.toContain('DELETE FROM app_users');
    expect(sql).toContain("CASE role WHEN 'Admin' THEN 'Moderator' ELSE 'Editor' END");
    expect(sql).toContain('session_version = session_version + 1');
    expect(sql).toContain("CHECK (role IN ('Editor', 'Moderator'))");
    expect(backupLimits.sql).toContain('ADD COLUMN backup_max_bytes bigint');
    const executed = database.client.query.mock.calls.map(([statement]) => statement);
    expect(executed).not.toContain(adminContract.sql);
  });

  it('drops the super-administrator column only when the contract is explicitly targeted', async () => {
    for (const id of ['006_canonical_tags_expand', ...defaultLevel]) database.applied.add(id);
    expect(adminContract.requiresExplicitTarget).toBe(true);
    await expect(runMigrations()).resolves.toEqual({ applied: [] });
    await expect(runMigrations({ targetId: '014_admin_account_contract' })).resolves.toEqual({ applied: ['014_admin_account_contract'] });
    expect(adminContract.sql).toContain('ALTER TABLE local_users DROP COLUMN is_super_admin');
  });

  it('keeps reviewable SQL copies of the inline migrations', () => {
    for (const migration of [adminAccount, backupLimits, adminContract]) {
      const file = readFileSync(new URL(`../migrations/${migration.id}.sql`, import.meta.url), 'utf8');
      expect(file.startsWith('BEGIN;')).toBe(true);
      expect(file.trimEnd().endsWith('COMMIT;')).toBe(true);
      for (const statement of migration.sql.split(';').map((part) => part.trim().split('\n')[0]).filter(Boolean)) {
        expect(file).toContain(statement);
      }
    }
  });

  it('never schema-qualifies objects, so restore can replay migrations in a staging schema', () => {
    for (const migration of migrations) {
      expect(migration.sql, migration.id).not.toMatch(/\bpublic\./i);
      expect(migration.sql, migration.id).not.toMatch(/search_path/i);
    }
  });

  it('replays migration SQL on an open transaction without recording it', async () => {
    const client = { query: vi.fn(async (_sql: string) => { void _sql; return { rows: [] }; }) };
    await applyMigrationSql(client, ['001_initial', '002_article_revisions']);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([migrations[0].sql, migrations[1].sql]);
    await expect(applyMigrationSql(client, ['999_unknown'])).rejects.toThrow('Unknown migration 999_unknown.');
  });

  it('rejects unknown targets before opening a database connection', async () => {
    await expect(runMigrations({ targetId: 'not-a-migration' })).rejects.toThrow('targetId must name a known migration.');
    expect(database.connect).not.toHaveBeenCalled();
  });
});
