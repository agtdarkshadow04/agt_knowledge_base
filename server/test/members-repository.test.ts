import assert from 'node:assert/strict';
import { beforeEach, describe, it, mock } from 'node:test';
import { MemberRepository } from '../repository/members.js';
import { assertCalledWith, assertMatches, dataWriteIt, fakeDatabase, rejectsMatching } from './helpers.js';

type Query = (sql: string, params?: unknown[]) => Promise<unknown>;

const database = {
  connect: mock.fn(async (): Promise<unknown> => undefined),
  query: mock.fn<Query>(async () => undefined),
};
const service = () => new MemberRepository({ db: fakeDatabase(database) });

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
  const query = mock.fn<Query>(async (sql) => {
    if (sql.includes('FOR UPDATE')) return { rowCount: rows.length, rows };
    if (sql.includes('RETURNING')) return { rowCount: 1, rows: [{ ...editorRow, role: 'Moderator' }] };
    return { rowCount: 0, rows: [] };
  });
  database.connect.mock.mockImplementation(async () => ({ query, release: mock.fn() }));
  return query;
}

describe('MemberRepository', () => {
  it('refuses to write outside withDataWrite(), so an undeclared route fails in tests (BAK-8)', async () => {
    fakeClient();
    await assert.rejects(service().deleteUser(editorRow.id), /outside withDataWrite\(\)/);
    assert.equal(database.connect.mock.callCount(), 0);
  });

  beforeEach(() => {
    database.connect.mock.restore();
    database.connect.mock.resetCalls();
    database.query.mock.restore();
    database.query.mock.resetCalls();
  });

  dataWriteIt('promotes a member to Moderator and signs them out when their role changes', async () => {
    const query = fakeClient();

    assertMatches(await service().updateUser(editorRow.id, {
      username: 'apollo',
      displayName: 'Apollo',
      role: 'Moderator',
      isActive: true,
    }), { role: 'Moderator' });

    const update = query.mock.calls.find(({ arguments: [sql] }) => sql.includes('UPDATE local_users'))!;
    assert.deepEqual(update.arguments[1], [editorRow.id, 'apollo', 'Apollo', null, 'Moderator', true, true]);
    // AUTH-4: a role change ends all of that member's sessions, in the same transaction.
    assertCalledWith(query, 'DELETE FROM member_sessions WHERE user_id = $1', [editorRow.id]);
    const sql = query.mock.calls.map(({ arguments: [statement] }) => statement);
    assert.ok(sql.indexOf('DELETE FROM member_sessions WHERE user_id = $1') < sql.indexOf('COMMIT'));
  });

  dataWriteIt('keeps sessions when nothing security-relevant changes', async () => {
    const query = fakeClient();
    await service().updateUser(editorRow.id, { username: 'apollo', displayName: 'Apollo Renamed', role: 'Editor', isActive: true });
    assert.equal(query.mock.calls.some(({ arguments: [sql] }) => sql.startsWith('DELETE FROM member_sessions')), false);
  });

  dataWriteIt('ends every session when the Admin sets a member\'s password (AUTH-4)', async () => {
    const query = fakeClient();
    await service().setPassword(editorRow.id, 'Replacement123!');
    assertCalledWith(query, 'DELETE FROM member_sessions WHERE user_id = $1', [editorRow.id]);
  });

  dataWriteIt('generates the ID of a new member with crypto.randomUUID() (DATA-6)', async () => {
    const query = fakeClient();
    await service().createUser({ username: 'hermes', displayName: 'Hermes', role: 'Editor', password: 'Permanent123!' });
    const insert = query.mock.calls.find(({ arguments: [sql] }) => sql.includes('INSERT INTO local_users'))!;
    assert.ok(insert.arguments[0].includes('INSERT INTO local_users (id, '));
    assert.match(String((insert.arguments[1] as unknown[])[5]), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  dataWriteIt('never returns or references a super-administrator flag', async () => {
    database.query.mock.mockImplementation(async (sql: string) => {
      assert.ok(!(sql).includes('is_super_admin'));
      return sql.includes('count(*)') ? { rows: [{ count: '1' }] } : { rows: [editorRow] };
    });

    const users = await service().listUsers({ search: '', role: 'all', active: 'all', page: 1, pageSize: 25 });
    assert.ok(!('isSuperAdmin' in users.items[0]));
    assertMatches(users.items[0], { username: 'apollo', role: 'Editor' });
  });

  dataWriteIt('reports a missing user without changing anything', async () => {
    const query = fakeClient([]);
    await rejectsMatching(service().deleteUser(editorRow.id), { statusCode: 404, error: 'not_found', legacyCode: 'USER_NOT_FOUND' });
    assert.ok(!query.mock.calls.some(({ arguments: [sql] }) => sql === 'DELETE FROM local_users WHERE id = $1'));
    assertCalledWith(query, 'ROLLBACK');
  });

  dataWriteIt('maps duplicate usernames to a conflict', async () => {
    const query = mock.fn<Query>(async (sql) => {
      if (sql.includes('INSERT INTO local_users')) throw Object.assign(new Error('duplicate'), { code: '23505' });
      return { rowCount: 0, rows: [] };
    });
    database.connect.mock.mockImplementation(async () => ({ query, release: mock.fn() }));

    await rejectsMatching(service().createUser({
      username: 'apollo',
      displayName: 'Apollo',
      role: 'Editor',
      password: 'Permanent123!',
    }), { statusCode: 409, error: 'conflict', legacyCode: 'USER_CONFLICT' });
  });
});
