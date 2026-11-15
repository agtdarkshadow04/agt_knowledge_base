import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';
import { assertDataWrite, withDataWrite } from '../dataWrite.js';
import { lockKey } from '../db.js';
import { fakeDatabase, rejectsMatching } from './helpers.js';

type QueryFn = (sql: string, values?: unknown[]) => Promise<unknown>;

/** A pool whose client reports `states` from control.operation, one per read. */
function fakePool(options: { states?: string[]; lockError?: unknown } = {}) {
  const states = [...(options.states ?? ['idle'])];
  const statements: string[] = [];
  const release = mock.fn((_error?: Error) => undefined);
  const query = mock.fn<QueryFn>(async (sql) => {
    statements.push(sql);
    if (sql.startsWith('SELECT pg_advisory_lock_shared') && options.lockError) throw options.lockError;
    if (sql.startsWith('SELECT state FROM control.operation')) {
      return { rows: [{ state: states.length > 1 ? states.shift() : states[0] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const connect = mock.fn(async () => ({ query, release }));
  return { db: fakeDatabase({ connect }), statements, release, connect };
}

const shared = `SELECT pg_advisory_lock_shared${lockKey('writes')}`;
const unshared = `SELECT pg_advisory_unlock_shared${lockKey('writes')}`;

describe('withDataWrite (BAK-8, BAK-12)', () => {
  it('takes the write lock shared, checks the state is idle in a transaction, runs the work marked, commits and unlocks', async () => {
    const { db, statements, release } = fakePool();
    const result = await withDataWrite(db, async () => {
      assertDataWrite();
      return 'written';
    });
    assert.equal(result, 'written');
    assert.deepEqual(statements, [
      "SET lock_timeout = '30s'", shared, 'RESET lock_timeout', 'BEGIN',
      'SELECT state FROM control.operation WHERE id = 1', 'COMMIT', unshared,
    ]);
    assert.equal(release.mock.calls[0].arguments[0], undefined);
  });

  it('waits while a backup holds the state, retrying each second, then writes', async () => {
    const { db, statements } = fakePool({ states: ['backup', 'backup', 'idle'] });
    const sleep = mock.fn(async (_milliseconds: number) => undefined);
    await withDataWrite(db, async () => undefined, { sleep, now: () => 0 });
    assert.deepEqual(sleep.mock.calls.map((call) => call.arguments[0]), [1000, 1000]);
    assert.equal(statements.filter((sql) => sql === shared).length, 3);
    assert.equal(statements.filter((sql) => sql === unshared).length, 3);
    assert.equal(statements.filter((sql) => sql === 'ROLLBACK').length, 2);
  });

  it('answers 503 maintenance after 30 seconds of backup, and at once during a restore or a failed restore', async () => {
    let clock = 0;
    const backup = fakePool({ states: ['backup'] });
    await rejectsMatching(
      withDataWrite(backup.db, async () => undefined, { sleep: async () => { clock += 10_000; }, now: () => clock }),
      { statusCode: 503, error: 'maintenance', params: { retryAfterSeconds: 10 } },
    );
    for (const state of ['restore', 'restore_failed']) {
      const work = mock.fn(async () => undefined);
      const { db, statements } = fakePool({ states: [state] });
      await rejectsMatching(withDataWrite(db, work), { statusCode: 503, error: 'maintenance' });
      assert.equal(work.mock.callCount(), 0);
      assert.equal(statements.at(-1), unshared);
    }
  });

  it('answers 503 maintenance when the write lock times out (55P03)', async () => {
    const { db, statements } = fakePool({ lockError: Object.assign(new Error('lock timeout'), { code: '55P03' }) });
    await rejectsMatching(withDataWrite(db, async () => undefined), { statusCode: 503, error: 'maintenance' });
    assert.ok(!statements.includes(unshared));
    assert.ok(statements.includes('RESET lock_timeout'));
  });

  it('rolls back, unlocks and releases when the work fails', async () => {
    const { db, statements, release } = fakePool();
    await assert.rejects(withDataWrite(db, async () => { throw new Error('conflict'); }), /conflict/);
    assert.deepEqual(statements.slice(-2), ['ROLLBACK', unshared]);
    assert.equal(release.mock.callCount(), 1);
  });

  it('joins an outer data write instead of taking the lock again', async () => {
    const { db, connect } = fakePool();
    await withDataWrite(db, async () => withDataWrite(db, async () => assertDataWrite()));
    assert.equal(connect.mock.callCount(), 1);
  });

  it('makes repository writes outside it throw', () => {
    assert.throws(() => assertDataWrite(), /outside withDataWrite\(\)/);
  });
});
