import { lockKey } from '../db.js';

/**
 * The SQL of the BAK-12 shared operation lock (SRV-4): the `control.operation`
 * row and the advisory locks. `server/operation.ts` and `server/dataWrite.ts`
 * hold the rules.
 */

/** A pool, a client or the control connection. */
export interface Sql {
  query<Row = unknown>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export type OperationState = 'idle' | 'backup' | 'restore' | 'restore_failed';
export type LockName = 'operation' | 'activity' | 'writes' | 'preview';

export interface OperationRow {
  state: OperationState;
  generation: string;
  owner: string | null;
  pre_restore_backup: string | null;
  admin_session_hash: string | null;
  admin_username: string | null;
  admin_session_expires_at: Date | null;
}

const columns = 'state, generation, owner, pre_restore_backup, admin_session_hash, admin_username, admin_session_expires_at';

export async function readOperation(sql: Sql) {
  return (await sql.query<OperationRow>(`SELECT ${columns} FROM control.operation WHERE id = 1`)).rows[0];
}

/** The state alone, read inside a data write's transaction (BAK-12 write procedure, step 2). */
export async function operationState(sql: Sql) {
  return (await sql.query<{ state: OperationState }>('SELECT state FROM control.operation WHERE id = 1')).rows[0]?.state;
}

/**
 * Takes an advisory lock, waiting at most 30 seconds when `timeout` is set
 * (SQLSTATE 55P03 on a timeout; the caller decides what it means).
 */
/**
 * Takes an advisory lock; with `timeout`, gives up after 30 seconds (BAK-8, BAK-12), or after the given number of
 * milliseconds (tests), with SQLSTATE 55P03.
 */
export async function advisoryLock(sql: Sql, name: LockName, options: { shared?: boolean; timeout?: boolean | number } = {}) {
  if (options.timeout) await sql.query(`SET lock_timeout = '${typeof options.timeout === 'number' ? `${Math.max(1, Math.round(options.timeout))}ms` : '30s'}'`);
  try {
    await sql.query(`SELECT pg_advisory_lock${options.shared ? '_shared' : ''}${lockKey(name)}`);
  } finally {
    if (options.timeout) await sql.query('RESET lock_timeout');
  }
}

export async function advisoryUnlock(sql: Sql, name: LockName, shared = false) {
  await sql.query(`SELECT pg_advisory_unlock${shared ? '_shared' : ''}${lockKey(name)}`);
}

export async function tryAdvisoryLock(sql: Sql, name: LockName) {
  return (await sql.query<{ locked: boolean }>(`SELECT pg_try_advisory_lock${lockKey(name)} AS locked`)).rows[0].locked;
}

/** Whether any session holds the operation lock exclusively (owner failure detection). */
export async function operationLockHeld(sql: Sql) {
  const result = await sql.query(
    `SELECT 1 FROM pg_locks
     WHERE locktype = 'advisory' AND granted
       AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
       AND classid = 0 AND objid = hashtext('agt_knowledge_base_operation')::oid AND objsubid = 2`,
  );
  return Boolean(result.rowCount);
}

/** Starting an operation, step 2: `idle` to `backup` or `restore`, with the recovery session of a restore. */
export async function startOperation(sql: Sql, input: {
  processId: string;
  kind: 'backup' | 'restore';
  session?: { tokenHash: string; username: string; expiresAt: Date };
}) {
  const { session } = input;
  return (await sql.query<OperationRow>(
    `UPDATE control.operation SET state = $2, generation = generation + 1, owner = $1, started_at = now(),
       pre_restore_backup = NULL, admin_session_hash = $3, admin_username = $4, admin_session_expires_at = $5
     WHERE id = 1 AND state = 'idle'
     RETURNING ${columns}`,
    [input.processId, input.kind, session?.tokenHash ?? null, session?.username ?? null, session?.expiresAt ?? null],
  )).rows[0];
}

/** A recovery restore (BAK-11): `restore_failed` to `restore`, only from the recorded session. */
export async function startRecoveryRestore(sql: Sql, processId: string, tokenHash: string | null) {
  return (await sql.query<OperationRow>(
    `UPDATE control.operation SET state = 'restore', generation = generation + 1, owner = $1, started_at = now()
     WHERE id = 1 AND state = 'restore_failed' AND admin_session_hash = $2
     RETURNING ${columns}`,
    [processId, tokenHash],
  )).rows[0];
}

export async function setPreRestoreBackup(sql: Sql, name: string) {
  await sql.query('UPDATE control.operation SET pre_restore_backup = $1 WHERE id = 1', [name]);
}

/** Finishing: `idle` with the recovery columns cleared. */
export async function finishIdle(sql: Sql) {
  await sql.query(
    `UPDATE control.operation SET state = 'idle', owner = NULL, started_at = NULL, pre_restore_backup = NULL,
       admin_session_hash = NULL, admin_username = NULL, admin_session_expires_at = NULL
     WHERE id = 1`,
  );
}

/** Finishing in `restore_failed`, keeping the recovery session and the pre-restore backup (BAK-11). */
export async function finishFailed(sql: Sql) {
  await sql.query("UPDATE control.operation SET state = 'restore_failed', owner = NULL WHERE id = 1");
}

/** Owner failure during a backup: nothing changed, back to `idle`. Only the process that sees `generation` acts. */
export async function abandonBackup(sql: Sql, generation: string) {
  await sql.query(
    "UPDATE control.operation SET state = 'idle', owner = NULL, started_at = NULL WHERE id = 1 AND generation = $1 AND state = 'backup'",
    [generation],
  );
}

/** Owner failure during a restore: `restore_failed`. True for the one process whose update applied. */
export async function markRestoreFailed(sql: Sql, generation: string) {
  const updated = await sql.query(
    "UPDATE control.operation SET state = 'restore_failed' WHERE id = 1 AND generation = $1 AND state = 'restore'",
    [generation],
  );
  return Boolean(updated.rowCount);
}
