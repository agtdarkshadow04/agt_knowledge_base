// @vitest-environment node
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

import { runMigrations } from './migrations-runner.js';
import { migrations } from './migrations.js';

const expansion = migrations.find((migration) => migration.id === '006_canonical_tags_expand')!;
const contract = migrations.find((migration) => migration.id === '007_canonical_tags_contract')!;
const localAuth = migrations.find((migration) => migration.id === '008_local_auth')!;
const admin = migrations.find((migration) => migration.id === '009_admin')!;
const agtVisibility = migrations.find((migration) => migration.id === '010_agt_visibility')!;

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
      applied: ['006_canonical_tags_expand', '008_local_auth', '009_admin', '010_agt_visibility'],
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

    await expect(runMigrations()).resolves.toEqual({ applied: ['008_local_auth', '009_admin', '010_agt_visibility'] });
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

  it('rejects unknown targets before opening a database connection', async () => {
    await expect(runMigrations({ targetId: 'not-a-migration' })).rejects.toThrow('targetId must name a known migration.');
    expect(database.connect).not.toHaveBeenCalled();
  });
});
