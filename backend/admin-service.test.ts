// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
}));

vi.mock('./db.js', () => ({ getPool: vi.fn(async () => database) }));

import { AdminService } from './admin-service.js';

const superAdmin = {
  id: '10000000-0000-4000-8000-000000000001',
  username: 'atlas',
  display_name: 'Atlas',
  email: 'atlas@example.com',
  role: 'Admin' as const,
  is_active: true,
  is_super_admin: true,
  session_version: 1,
  created_at: '2026-10-10T00:00:00.000Z',
  updated_at: '2026-10-10T00:00:00.000Z',
};

describe('AdminService', () => {
  beforeEach(() => {
    database.connect.mockReset();
    database.query.mockReset();
  });

  it('locks the user table before checking bootstrap eligibility', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'SELECT 1 FROM local_users LIMIT 1') return { rowCount: 0, rows: [] };
      if (sql.includes('INSERT INTO local_users')) return { rowCount: 1, rows: [superAdmin] };
      return { rowCount: 0, rows: [] };
    });
    database.connect.mockResolvedValue({ query, release: vi.fn() });

    await expect(new AdminService().bootstrap({
      username: 'atlas',
      displayName: 'Atlas',
      email: 'atlas@example.com',
      password: 'Permanent123!',
    })).resolves.toMatchObject({ sub: superAdmin.id, isSuperAdmin: true, sessionVersion: 1 });

    const statements = query.mock.calls.map(([sql]) => sql);
    expect(statements.indexOf('LOCK TABLE local_users IN SHARE ROW EXCLUSIVE MODE'))
      .toBeLessThan(statements.indexOf('SELECT 1 FROM local_users LIMIT 1'));
    expect(statements).toContain('COMMIT');
  });

  it('rejects setup once any local user exists', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql === 'SELECT 1 FROM local_users LIMIT 1') return { rowCount: 1, rows: [{}] };
      return { rowCount: 0, rows: [] };
    });
    database.connect.mockResolvedValue({ query, release: vi.fn() });

    await expect(new AdminService().bootstrap({
      username: 'second',
      displayName: 'Second',
      password: 'Permanent123!',
    })).rejects.toMatchObject({ statusCode: 409, code: 'SETUP_ALREADY_COMPLETED' });
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('prevents another administrator from changing the super administrator', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("role = 'Admin'")) return { rowCount: 1, rows: [{}] };
      if (sql.includes('FOR UPDATE')) return { rowCount: 1, rows: [superAdmin] };
      return { rowCount: 0, rows: [] };
    });
    database.connect.mockResolvedValue({ query, release: vi.fn() });

    await expect(new AdminService().updateUser(superAdmin.id, {
      username: 'taken-over',
      displayName: 'Taken over',
      email: undefined,
      role: 'Admin',
      isActive: true,
    }, { sub: '20000000-0000-4000-8000-000000000002', displayName: 'Other Admin', role: 'Admin' }))
      .rejects.toMatchObject({ statusCode: 409, code: 'PROTECTED_USER' });
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('UPDATE local_users'), expect.anything());
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('returns an optimistic concurrency conflict for stale settings', async () => {
    database.query.mockResolvedValue({ rows: [] });
    await expect(new AdminService().updateSettings({
      applicationName: 'Archive',
      applicationSubtitle: 'A local archive',
      defaultVisibility: 'Internal',
      allowPublicBrowsing: true,
      version: 2,
    })).rejects.toMatchObject({ statusCode: 409, code: 'VERSION_CONFLICT' });
  });
});
