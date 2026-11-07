// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const database = vi.hoisted(() => ({
  connect: vi.fn(),
  query: vi.fn(),
}));

vi.mock('./db.js', () => ({ getPool: vi.fn(async () => database) }));

import { AdminService } from './admin-service.js';

const editorRow = {
  id: '10000000-0000-4000-8000-000000000001',
  username: 'apollo',
  display_name: 'Apollo',
  email: 'apollo@example.com',
  role: 'Editor' as const,
  is_active: true,
  session_version: 1,
  created_at: '2026-10-10T00:00:00.000Z',
  updated_at: '2026-10-10T00:00:00.000Z',
};

function fakeClient(rows = [editorRow]) {
  const query = vi.fn(async (sql: string, _params?: unknown[]) => {
    void _params;
    if (sql.includes('FOR UPDATE')) return { rowCount: rows.length, rows };
    if (sql.includes('RETURNING')) return { rowCount: 1, rows: [{ ...editorRow, role: 'Moderator' }] };
    return { rowCount: 0, rows: [] };
  });
  database.connect.mockResolvedValue({ query, release: vi.fn() });
  return query;
}

describe('AdminService', () => {
  beforeEach(() => {
    database.connect.mockReset();
    database.query.mockReset();
  });

  it('promotes a member to Moderator and signs them out when their role changes', async () => {
    const query = fakeClient();

    await expect(new AdminService().updateUser(editorRow.id, {
      username: 'apollo',
      displayName: 'Apollo',
      role: 'Moderator',
      isActive: true,
    })).resolves.toMatchObject({ role: 'Moderator' });

    const update = query.mock.calls.find(([sql]) => sql.includes('UPDATE local_users'))!;
    expect(update[1]).toEqual([editorRow.id, 'apollo', 'Apollo', null, 'Moderator', true, true]);
    expect(query).toHaveBeenCalledWith('COMMIT');
  });

  it('never returns or references a super-administrator flag', async () => {
    database.query.mockImplementation(async (sql: string) => {
      expect(sql).not.toContain('is_super_admin');
      return sql.includes('count(*)') ? { rows: [{ count: '1' }] } : { rows: [editorRow] };
    });

    const users = await new AdminService().listUsers({ search: '', role: 'all', active: 'all', page: 1, pageSize: 25 });
    expect(users.items[0]).not.toHaveProperty('isSuperAdmin');
    expect(users.items[0]).toMatchObject({ username: 'apollo', role: 'Editor' });
  });

  it('reports a missing user without changing anything', async () => {
    const query = fakeClient([]);
    await expect(new AdminService().deleteUser(editorRow.id)).rejects.toMatchObject({ statusCode: 404, code: 'USER_NOT_FOUND' });
    expect(query).not.toHaveBeenCalledWith('DELETE FROM local_users WHERE id = $1', expect.anything());
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('maps duplicate usernames to a conflict', async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes('INSERT INTO local_users')) throw Object.assign(new Error('duplicate'), { code: '23505' });
      return { rowCount: 0, rows: [] };
    });
    database.connect.mockResolvedValue({ query, release: vi.fn() });

    await expect(new AdminService().createUser({
      username: 'apollo',
      displayName: 'Apollo',
      role: 'Editor',
      password: 'Permanent123!',
    })).rejects.toMatchObject({ statusCode: 409, code: 'USER_CONFLICT' });
  });
});
