import { dataWriteScope, type Database } from './db.js';
import { MaintenanceError } from './http.js';
import { advisoryLock, advisoryUnlock, operationState } from './repository/control.js';

/**
 * Data writes (BAK-8, BAK-12). Every change to the main database goes through
 * `withDataWrite()`: it takes the shared write lock on one pool client, checks
 * in a transaction that no backup or restore is running, and runs the write on
 * that client, so a backup or restore owner that takes the write lock
 * exclusively drains the writes of every process. Session rows (sign-in,
 * sign-out, expiry purges) are not data writes.
 */

/** How long a write waits for a backup to end before it answers `503 maintenance` (BAK-8). */
export const backupWaitMilliseconds = 30_000;

export interface DataWriteOptions {
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

function isLockTimeout(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03';
}

/**
 * Runs `work` as one data write (BAK-12, "Every data write"):
 * 1. take the write lock shared, with a 30-second lock timeout (`503 maintenance` on a timeout);
 * 2. `BEGIN` and read `control.operation.state`: `idle` continues; `backup` rolls back,
 *    unlocks and tries again each second for up to 30 seconds; `restore` and
 *    `restore_failed` answer `503 maintenance` at once;
 * 3. run `work`, whose repository calls all use this client, and `COMMIT`;
 * 4. always unlock and release the client (destroyed after an error).
 * A nested call joins the outer write.
 */
export async function withDataWrite<T>(db: Pick<Database, 'pool'>, work: () => Promise<T>, options: DataWriteOptions = {}): Promise<T> {
  if (dataWriteScope.getStore()) return work();
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? wait;
  const started = now();
  const pool = await db.pool();
  for (;;) {
    const client = await pool.connect();
    let broken: Error | undefined;
    let locked = false;
    let open = false;
    try {
      try {
        await advisoryLock(client, 'writes', { shared: true, timeout: true });
        locked = true;
      } catch (error) {
        if (isLockTimeout(error)) throw new MaintenanceError();
        throw error;
      }
      await client.query('BEGIN');
      open = true;
      const state = await operationState(client);
      if (state === 'idle') {
        const result = await dataWriteScope.run({ client }, work);
        await client.query('COMMIT');
        open = false;
        return result;
      }
      await client.query('ROLLBACK');
      open = false;
      if (state !== 'backup' || now() - started >= backupWaitMilliseconds) throw new MaintenanceError();
    } catch (error) {
      if (open) {
        await client.query('ROLLBACK').catch((rollbackError: unknown) => {
          broken = rollbackError instanceof Error ? rollbackError : new Error(String(rollbackError));
        });
      }
      throw error;
    } finally {
      if (locked) {
        await advisoryUnlock(client, 'writes', true).catch((unlockError: unknown) => {
          broken ??= unlockError instanceof Error ? unlockError : new Error(String(unlockError));
        });
      }
      client.release(broken);
    }
    await sleep(1000);
  }
}

/**
 * Marks `work` as a data write without any locking. For callers that already
 * hold the write lock exclusively (the backup or restore owner) and for tests
 * of repositories.
 */
export function asDataWrite<T>(work: () => Promise<T>): Promise<T> {
  return dataWriteScope.run({}, work);
}

/**
 * Every repository function that writes the main database calls this first:
 * outside `withDataWrite()` it throws, so a write that a route forgot to
 * declare fails in tests instead of slipping past a backup (BAK-8).
 */
export function assertDataWrite() {
  if (!dataWriteScope.getStore()) {
    throw new Error('A data write ran outside withDataWrite(). Declare writesData on the route (BAK-8).');
  }
}
