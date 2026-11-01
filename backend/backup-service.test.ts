// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
}));

vi.mock('./db.js', () => ({ getPool: vi.fn(async () => database) }));

import { BackupService, backupTables, type DatabaseBackup } from './backup-service.js';
import { migrations as schemaMigrations } from './migrations.js';
import type { Actor } from './domain.js';

const superAdmin: Actor = {
  sub: '10000000-0000-4000-8000-000000000001',
  displayName: 'Atlas',
  role: 'Admin',
  isSuperAdmin: true,
};

const migrations = ['001_initial', '002_article_revisions'];

const columns: Record<string, string[]> = {
  app_users: ['user_id', 'display_name'],
  local_users: ['id', 'username', 'role', 'is_active', 'is_super_admin', 'session_version'],
  tags: ['id', 'name', 'color'],
  articles: ['id', 'title', 'tag_ids'],
  article_revisions: ['article_id', 'version'],
  application_settings: ['singleton', 'application_name'],
};

const columnRows = [
  ...Object.entries(columns).flatMap(([table, names]) => names.map((name) => ({
    table_name: table,
    column_name: name,
    is_generated: 'NEVER',
  }))),
  { table_name: 'articles', column_name: 'search_vector', is_generated: 'ALWAYS' },
];

function backup(overrides: Partial<DatabaseBackup['tables']> = {}, backupMigrations = migrations): DatabaseBackup {
  return {
    format: 'agt-knowledge-base-backup',
    formatVersion: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    migrations: backupMigrations,
    tables: {
      app_users: [{ user_id: superAdmin.sub, display_name: 'Atlas' }],
      local_users: [{
        id: superAdmin.sub,
        username: 'atlas',
        role: 'Admin',
        is_active: true,
        is_super_admin: true,
        session_version: 3,
      }],
      tags: [],
      articles: [{ id: '00000000-0000-4000-8000-000000000001', title: 'Portal Guide', tag_ids: [] }],
      article_revisions: [{ article_id: '00000000-0000-4000-8000-000000000001', version: 1 }],
      application_settings: [{ singleton: true, application_name: 'Archive' }],
      ...overrides,
    },
  };
}

function fakeClient(options: { isSuperAdmin?: boolean; failInsert?: { code: string; message: string; table?: string; constraint?: string } } = {}) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes('is_super_admin = true')) {
      return { rowCount: options.isSuperAdmin === false ? 0 : 1, rows: [] };
    }
    if (sql.includes('FROM schema_migrations')) return { rowCount: migrations.length, rows: migrations.map((id) => ({ id })) };
    if (sql.includes('information_schema.columns')) return { rowCount: columnRows.length, rows: columnRows };
    if (sql.includes('jsonb_agg')) {
      const table = /FROM "([a-z_]+)" source/.exec(sql)?.[1];
      return { rowCount: 1, rows: [{ rows: [{ table, excluded: params?.[0] }] }] };
    }
    if (sql.startsWith('INSERT INTO') && options.failInsert) throw Object.assign(new Error(options.failInsert.message), options.failInsert);
    return { rowCount: 0, rows: [] };
  });
  const client = { query, release: vi.fn() };
  database.connect.mockResolvedValue(client);
  return client;
}

function statements(client: ReturnType<typeof fakeClient>) {
  return client.query.mock.calls.map(([sql]) => sql);
}

describe('BackupService', () => {
  beforeEach(() => {
    database.connect.mockReset();
    database.query.mockReset();
  });

  it('covers every table the migrations create', () => {
    const created = schemaMigrations.flatMap((migration) => [...migration.sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z_]+)/g)]
      .map((match) => match[1]));
    expect([...new Set(created)].sort()).toEqual([...backupTables].sort());
  });

  it('exports every table from one read-only snapshot without generated columns', async () => {
    const client = fakeClient();

    const result = await new BackupService().export(superAdmin);

    expect(statements(client)[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(result).toMatchObject({ format: 'agt-knowledge-base-backup', formatVersion: 1, migrations });
    expect(Object.keys(result.tables)).toEqual([...backupTables]);
    expect(result.tables.articles).toEqual([{ table: 'articles', excluded: ['search_vector'] }]);
    expect(result.tables.tags).toEqual([{ table: 'tags', excluded: [] }]);
    expect(statements(client)).toContain('COMMIT');
    expect(client.release).toHaveBeenCalled();
  });

  it('rejects exports by anyone who is not the active super administrator', async () => {
    const client = fakeClient({ isSuperAdmin: false });

    await expect(new BackupService().export({ ...superAdmin, sub: '20000000-0000-4000-8000-000000000002' }))
      .rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(statements(client).some((sql) => sql.includes('jsonb_agg'))).toBe(false);
    expect(statements(client)).toContain('ROLLBACK');
  });

  it('replaces all data in one transaction and signs every user out', async () => {
    const client = fakeClient();

    await expect(new BackupService().restore(backup(), superAdmin)).resolves.toEqual({
      app_users: 1,
      local_users: 1,
      tags: 0,
      articles: 1,
      article_revisions: 1,
      application_settings: 1,
    });

    const sql = statements(client);
    const truncate = sql.findIndex((statement) => statement.startsWith('TRUNCATE'));
    expect(sql[0]).toBe('BEGIN');
    expect(sql[truncate]).toBe(`TRUNCATE ${backupTables.map((table) => `"${table}"`).join(', ')}`);
    expect(sql.findIndex((statement) => statement.includes('is_super_admin = true'))).toBeLessThan(truncate);
    expect(sql.filter((statement) => statement.endsWith('DISABLE TRIGGER USER'))).toHaveLength(backupTables.length);
    expect(sql.filter((statement) => statement.endsWith('ENABLE TRIGGER USER'))).toHaveLength(backupTables.length);

    const inserts = client.query.mock.calls.filter(([statement]) => statement.startsWith('INSERT INTO'));
    expect(inserts.map(([statement]) => /INSERT INTO "([a-z_]+)"/.exec(statement)?.[1]))
      .toEqual(['app_users', 'local_users', 'articles', 'article_revisions', 'application_settings']);
    const articleInsert = inserts.find(([statement]) => statement.startsWith('INSERT INTO "articles"'))!;
    expect(articleInsert[0]).toContain('("id", "title", "tag_ids")');
    expect(articleInsert[0]).not.toContain('search_vector');
    expect(JSON.parse(String(articleInsert[1]?.[0]))).toEqual(backup().tables.articles);

    const bump = sql.indexOf('UPDATE local_users SET session_version = session_version + 1');
    expect(bump).toBeGreaterThan(truncate);
    expect(sql.indexOf('COMMIT')).toBeGreaterThan(bump);
  });

  it('rejects restores by anyone who is not the active super administrator before changing data', async () => {
    const client = fakeClient({ isSuperAdmin: false });

    await expect(new BackupService().restore(backup(), superAdmin))
      .rejects.toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
    expect(statements(client).some((sql) => sql.startsWith('TRUNCATE'))).toBe(false);
    expect(statements(client)).toContain('ROLLBACK');
  });

  it('rejects backups from a different schema version before changing data', async () => {
    const client = fakeClient();

    await expect(new BackupService().restore(backup({}, ['001_initial']), superAdmin))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_BACKUP' });
    expect(statements(client).some((sql) => sql.startsWith('TRUNCATE'))).toBe(false);
    expect(statements(client)).toContain('ROLLBACK');
  });

  it('rejects rows whose columns do not match the table before changing data', async () => {
    const client = fakeClient();
    const tampered = backup({ tags: [{ id: 'x', name: 'Portal', color: '#FFFFFF', search_vector: 'x' }] });

    await expect(new BackupService().restore(tampered, superAdmin))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_BACKUP' });
    expect(statements(client).some((sql) => sql.startsWith('TRUNCATE'))).toBe(false);
  });

  it('requires exactly one active super administrator in the backup', async () => {
    fakeClient();
    const withoutSuperAdmin = backup({
      local_users: [{ id: superAdmin.sub, username: 'atlas', role: 'Admin', is_active: true, is_super_admin: false, session_version: 1 }],
    });
    const inactiveSuperAdmin = backup({
      local_users: [{ id: superAdmin.sub, username: 'atlas', role: 'Admin', is_active: false, is_super_admin: true, session_version: 1 }],
    });

    await expect(new BackupService().restore(withoutSuperAdmin, superAdmin))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_BACKUP' });
    await expect(new BackupService().restore(inactiveSuperAdmin, superAdmin))
      .rejects.toMatchObject({ statusCode: 400, code: 'INVALID_BACKUP' });
    expect(database.connect).not.toHaveBeenCalled();
  });

  it('rolls back and reports constraint violations as an invalid backup', async () => {
    const client = fakeClient({ failInsert: {
      code: '23503',
      message: 'insert or update violates foreign key constraint "articles_created_by_fkey" (secret value)',
      table: 'articles',
      constraint: 'articles_created_by_fkey',
    } });

    await expect(new BackupService().restore(backup(), superAdmin)).rejects.toMatchObject({
      statusCode: 400,
      code: 'INVALID_BACKUP',
      message: 'The backup cannot be restored: a row in articles violates the articles_created_by_fkey constraint.',
    });
    expect(statements(client)).toContain('ROLLBACK');
    expect(statements(client)).not.toContain('COMMIT');
  });
});
