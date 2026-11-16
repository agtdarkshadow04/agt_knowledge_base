import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it, mock } from 'node:test';
import { parseConfig } from '../config.js';
import { lockKey } from '../db.js';
import { PostgresOperations } from '../operation.js';
import { fakeDatabase, rejectsMatching } from './helpers.js';

const dataDir = mkdtempSync(join(tmpdir(), 'agt-operation-'));
after(() => rmSync(dataDir, { recursive: true, force: true }));
const marker = join(dataDir, 'restore-failed.json');

interface Row {
  state: string;
  generation: string;
  owner: string | null;
  pre_restore_backup: string | null;
  admin_session_hash: string | null;
  admin_username: string | null;
  admin_session_expires_at: Date | null;
}

/** A control connection over an in-memory `control.operation` row and advisory locks held elsewhere. */
function fakeControl(options: { row?: Partial<Row>; operationLockTaken?: boolean; ownerAlive?: boolean; lockTimeout?: string } = {}) {
  const row: Row = {
    state: 'idle', generation: '0', owner: null, pre_restore_backup: null,
    admin_session_hash: null, admin_username: null, admin_session_expires_at: null, ...options.row,
  };
  const statements: string[] = [];
  const client = Object.assign(new EventEmitter(), {
    connect: async () => undefined,
    end: async () => undefined,
    query: mock.fn(async (sql: string, values: unknown[] = []) => {
      statements.push(sql);
      if (options.lockTimeout && sql === `SELECT pg_advisory_lock${lockKey(options.lockTimeout as 'writes')}`) {
        throw Object.assign(new Error('lock timeout'), { code: '55P03' });
      }
      if (sql.startsWith('SELECT state, generation')) return { rows: [{ ...row }], rowCount: 1 };
      if (sql.startsWith('SELECT pg_try_advisory_lock')) return { rows: [{ locked: !options.operationLockTaken }], rowCount: 1 };
      if (sql.includes('FROM pg_locks')) return { rows: options.ownerAlive ? [{}] : [], rowCount: options.ownerAlive ? 1 : 0 };
      if (sql.startsWith('UPDATE control.operation SET state = $2')) {
        if (row.state !== 'idle') return { rows: [], rowCount: 0 };
        Object.assign(row, { state: values[1], generation: String(Number(row.generation) + 1), owner: values[0], admin_session_hash: values[2], admin_username: values[3], admin_session_expires_at: values[4] });
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE control.operation SET state = 'restore', generation")) {
        if (row.state !== 'restore_failed' || row.admin_session_hash !== values[1]) return { rows: [], rowCount: 0 };
        Object.assign(row, { state: 'restore', generation: String(Number(row.generation) + 1), owner: values[0] });
        return { rows: [{ ...row }], rowCount: 1 };
      }
      if (sql.startsWith("UPDATE control.operation SET state = 'idle', owner = NULL, started_at = NULL, pre_restore_backup")) {
        Object.assign(row, { state: 'idle', owner: null, pre_restore_backup: null, admin_session_hash: null, admin_username: null, admin_session_expires_at: null });
      } else if (sql.startsWith("UPDATE control.operation SET state = 'idle'")) {
        Object.assign(row, { state: 'idle', owner: null });
        return { rows: [], rowCount: 1 };
      } else if (sql.startsWith("UPDATE control.operation SET state = 'restore_failed' WHERE")) {
        if (row.state !== 'restore') return { rows: [], rowCount: 0 };
        row.state = 'restore_failed';
        return { rows: [], rowCount: 1 };
      } else if (sql.startsWith("UPDATE control.operation SET state = 'restore_failed'")) {
        row.state = 'restore_failed';
      } else if (sql.startsWith('UPDATE control.operation SET pre_restore_backup')) {
        row.pre_restore_backup = values[0] as string;
      }
      return { rows: [], rowCount: 0 };
    }),
  });
  const close = mock.fn(async () => undefined);
  const db = { ...fakeDatabase({}), client: () => client as never, close };
  return { client, row, statements, db };
}

async function started(control: ReturnType<typeof fakeControl>) {
  const operations = new PostgresOperations({ config: parseConfig(`storage:\n  dataDir: ${dataDir}\n`), db: control.db }, { pollMilliseconds: 60_000 });
  // Startup without the migration steps, which db.test.ts covers: connect and read the state.
  await (operations as unknown as { connect(): Promise<unknown> }).connect();
  await operations.follow();
  return operations;
}

const session = { tokenHash: 'a'.repeat(64), username: 'atlas', expiresAt: new Date(Date.now() + 3_600_000) };

describe('admission under the activity lease (BAK-12)', () => {
  it('takes the shared lease once, reads the state for every request, and releases the lease when the last request ends', async () => {
    const control = fakeControl();
    const operations = await started(control);
    const first = await operations.admit({ routeKey: 'GET /api/articles' });
    const second = await operations.admit({ routeKey: 'GET /api/tags' });
    assert.equal(control.statements.filter((sql) => sql === `SELECT pg_advisory_lock_shared${lockKey('activity')}`).length, 1);
    assert.ok(control.statements.includes("SET lock_timeout = '30s'"));
    first.release();
    first.release();
    second.release();
    await operations.admit({ routeKey: 'GET /api/health' }).then((admission) => admission.release());
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(control.statements.filter((sql) => sql === `SELECT pg_advisory_unlock_shared${lockKey('activity')}`).length >= 1);
  });

  it('admits nothing new during a restore, answering 503 maintenance and dropping an unused lease', async () => {
    const control = fakeControl({ row: { state: 'restore' }, ownerAlive: true });
    const operations = new PostgresOperations({ config: parseConfig(`storage:\n  dataDir: ${dataDir}\n`), db: control.db });
    await (operations as unknown as { connect(): Promise<unknown> }).connect();
    await rejectsMatching(operations.admit({ routeKey: 'GET /api/articles' }), { statusCode: 503, error: 'maintenance' });
    assert.equal(control.statements.at(-1), `SELECT pg_advisory_unlock_shared${lockKey('activity')}`);
    // Once it follows the restore, it answers without queueing on the control connection.
    const before = control.statements.length;
    await rejectsMatching(operations.admit({ routeKey: 'GET /api/articles' }), { statusCode: 503 });
    assert.equal(control.statements.length, before);
    assert.equal(operations.state, 'restore');
  });

  it('admits only the recovery session, only for its two routes and before its expiry, while a restore is failed (BAK-11)', async () => {
    const control = fakeControl({ row: { state: 'restore_failed', admin_session_hash: session.tokenHash, admin_username: 'atlas', admin_session_expires_at: session.expiresAt } });
    const operations = await started(control);
    const admitted = await operations.admit({ routeKey: 'GET /api/admin/session', adminTokenHash: session.tokenHash });
    assert.deepEqual(admitted.recovery, { username: 'atlas' });
    admitted.release();
    await rejectsMatching(operations.admit({ routeKey: 'POST /api/admin/restore', adminTokenHash: 'b'.repeat(64) }), { statusCode: 503 });
    await rejectsMatching(operations.admit({ routeKey: 'GET /api/admin/users', adminTokenHash: session.tokenHash }), { statusCode: 503 });
    control.row.admin_session_expires_at = new Date(Date.now() - 1000);
    await rejectsMatching(operations.admit({ routeKey: 'POST /api/admin/restore', adminTokenHash: session.tokenHash }), { statusCode: 503 });
  });
});

describe('running a backup or restore (BAK-12)', () => {
  it('answers 409 conflict when the operation lock is taken or the state is not idle, changing nothing', async () => {
    const taken = await started(fakeControl({ operationLockTaken: true }));
    await rejectsMatching(taken.run('backup', {}, async () => 'never'), { statusCode: 409, error: 'conflict', message: 'A backup or restore is already running.' });
    const busy = fakeControl({ row: { state: 'backup' }, ownerAlive: true });
    const operations = await started(busy);
    await rejectsMatching(operations.run('restore', { session }, async () => 'never'), { statusCode: 409 });
    assert.equal(busy.statements.at(-1), `SELECT pg_advisory_unlock${lockKey('operation')}`);
  });

  it('takes the operation, activity and write locks in order for a restore and releases them in reverse, ending idle', async () => {
    const control = fakeControl();
    const operations = await started(control);
    const result = await operations.run('restore', { session }, async (run) => {
      assert.equal(operations.state, 'restore');
      assert.equal(control.row.admin_session_hash, session.tokenHash);
      await run.setPreRestoreBackup('pre-restore-backup-1.zip');
      return 'restored';
    });
    assert.equal(result, 'restored');
    const locks = control.statements.filter((sql) => /pg_(try_)?advisory_(un)?lock\(/.test(sql));
    assert.deepEqual(locks, [
      `SELECT pg_try_advisory_lock${lockKey('operation')} AS locked`,
      `SELECT pg_advisory_lock${lockKey('activity')}`,
      `SELECT pg_advisory_lock${lockKey('writes')}`,
      `SELECT pg_advisory_unlock${lockKey('writes')}`,
      `SELECT pg_advisory_unlock${lockKey('activity')}`,
      `SELECT pg_advisory_unlock${lockKey('operation')}`,
    ]);
    assert.equal(control.row.state, 'idle');
    assert.equal(control.row.admin_session_hash, null);
    assert.equal(operations.state, 'idle');
  });

  it('takes no activity lock for a backup', async () => {
    const control = fakeControl();
    const operations = await started(control);
    await operations.run('backup', {}, async () => undefined);
    assert.ok(!control.statements.includes(`SELECT pg_advisory_lock${lockKey('activity')}`));
    assert.ok(control.statements.includes(`SELECT pg_advisory_lock${lockKey('writes')}`));
  });

  it('answers 409 "The server is busy" and returns to idle when the write lock times out', async () => {
    const control = fakeControl({ lockTimeout: 'writes' });
    const operations = await started(control);
    const work = mock.fn(async () => undefined);
    await rejectsMatching(operations.run('backup', {}, work), { statusCode: 409, message: 'The server is busy. Try again.' });
    assert.equal(work.mock.callCount(), 0);
    assert.equal(control.row.state, 'idle');
  });

  it('ends a restore whose rollback failed in restore_failed, keeping the recovery session and writing the marker (BAK-11)', async () => {
    const control = fakeControl();
    const operations = await started(control);
    await assert.rejects(operations.run('restore', { session }, async (run) => {
      run.fail('pre-restore-backup-1.zip');
      throw new Error('rollback failed');
    }), /rollback failed/);
    assert.equal(control.row.state, 'restore_failed');
    assert.equal(control.row.admin_session_hash, session.tokenHash);
    assert.equal(operations.state, 'restore_failed');
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).preRestoreBackup, 'pre-restore-backup-1.zip');

    // A recovery restore from that session starts from restore_failed; a failure keeps it there.
    await assert.rejects(operations.run('restore', { session, recovery: true }, async () => { throw new Error('again'); }), /again/);
    assert.equal(control.row.state, 'restore_failed');
    assert.ok(existsSync(marker));
    // Its success returns to idle and deletes the marker.
    await operations.run('restore', { session, recovery: true }, async () => undefined);
    assert.equal(control.row.state, 'idle');
    assert.ok(!existsSync(marker));
  });

  it('refuses a recovery restore from any other session', async () => {
    const control = fakeControl({ row: { state: 'restore_failed', admin_session_hash: session.tokenHash } });
    const operations = await started(control);
    await rejectsMatching(operations.run('restore', { session: { ...session, tokenHash: 'c'.repeat(64) }, recovery: true }, async () => undefined), { statusCode: 409 });
    assert.equal(control.row.state, 'restore_failed');
  });

  it('fails the operation at once when the control connection drops (owner connection loss)', async () => {
    const control = fakeControl();
    const operations = await started(control);
    await assert.rejects(operations.run('restore', { session }, async (run) => {
      control.client.emit('end');
      assert.ok(run.signal.aborted);
      throw run.signal.reason;
    }), /control connection dropped/);
    assert.equal(operations.state, 'restore_failed');
    assert.ok(existsSync(marker));
    rmSync(marker);
  });
});

describe('following the shared state (BAK-12)', () => {
  it('returns an abandoned backup to idle when its owner holds no operation lock', async () => {
    const control = fakeControl({ row: { state: 'backup', generation: '4' } });
    await started(control);
    assert.equal(control.row.state, 'idle');
    assert.ok(control.statements.some((sql) => sql.includes('FROM pg_locks') && sql.includes('objsubid = 2')));
  });

  it('marks a restore whose owner died restore_failed and writes the marker naming its pre-restore backup', async () => {
    const control = fakeControl({ row: { state: 'restore', generation: '7', pre_restore_backup: 'pre-restore-backup-7.zip' } });
    const operations = await started(control);
    assert.equal(control.row.state, 'restore_failed');
    assert.equal(operations.state, 'restore_failed');
    assert.equal(JSON.parse(readFileSync(marker, 'utf8')).preRestoreBackup, 'pre-restore-backup-7.zip');
    rmSync(marker);
  });

  it('leaves a live owner alone, and recreates the pool once the restore has ended', async () => {
    const control = fakeControl({ row: { state: 'restore', generation: '2' }, ownerAlive: true });
    const operations = await started(control);
    assert.equal(operations.state, 'restore');
    control.row.state = 'idle';
    await operations.follow();
    assert.equal(operations.state, 'idle');
    assert.equal(control.db.close.mock.callCount(), 1);
  });
});
