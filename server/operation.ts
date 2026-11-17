import { randomUUID } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type pg from 'pg';
import type { AppContext } from './context.js';
import { migrateAtStartup } from './db.js';
import { MaintenanceError, operationConflict } from './http.js';
import * as control from './repository/control.js';
import type { OperationRow as ControlRow, OperationState } from './repository/control.js';

/**
 * The shared operation lock of BAK-8 and BAK-12. PostgreSQL's advisory locks
 * do the fencing across every process; `control.operation` only decides how
 * requests are answered. Each process keeps one control connection for its
 * whole life, admits every `/api/` request (except `GET /api/health`) through
 * it under the shared activity lease, follows the shared state every second,
 * and, as the owner of a backup or restore, holds the operation, activity and
 * write locks on it.
 */

export type { OperationState } from './repository/control.js';
export type OperationKind = 'backup' | 'restore';

export interface OperationLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** The restoring Admin's session (BAK-11): SHA-256 of its token, the username and its expiry. */
export interface RecoverySession {
  tokenHash: string;
  username: string;
  expiresAt: Date;
}

export interface AdmissionRequest {
  /** The route key, e.g. `POST /api/admin/restore`. */
  routeKey: string;
  /** SHA-256 of the Admin session cookie, if the request has one (recovery session, BAK-11). */
  adminTokenHash?: string;
}

export interface Admission {
  /** Ends the request's share of the activity lease; call it exactly once, when the request ends. */
  release(): void;
  /**
   * Aborted, with a `MaintenanceError`, when the control connection drops and
   * the lease is gone (BAK-12): the request must stop and answer `503`, and
   * its file streams stop too.
   */
  readonly signal: AbortSignal;
  /** Set when the request was admitted as the BAK-11 recovery session during `restore_failed`. */
  recovery?: { username: string };
}

/** What an operation's work can do while it owns the lock. */
export interface OperationRun {
  /** Aborted when the control connection drops: stop at once, touch no more files (BAK-12). */
  readonly signal: AbortSignal;
  /** Runs statements on the control connection, which holds the owner's locks. */
  control<T>(work: (client: pg.Client) => Promise<T>): Promise<T>;
  /** Stores the pre-restore backup's file name in `control.operation` (BAK-4 step 3). */
  setPreRestoreBackup(name: string): Promise<void>;
  /** Ends the operation in `restore_failed` instead of `idle` (BAK-11). */
  fail(preRestoreBackup: string | null): void;
  /** The pre-restore backup a recovery restore keeps naming (BAK-11). */
  readonly preRestoreBackup: string | null;
}

export interface RunOptions {
  /** A restore records the caller's session as the recovery session (BAK-11). */
  session?: RecoverySession;
  /** A recovery restore: starts from `restore_failed`, from the recovery session only (BAK-11). */
  recovery?: boolean;
}

/** The operation lock as the app and its services use it; tests use a fake. */
export interface Operations {
  /** The local state (BAK-8), which decides `503 maintenance` and the health status. */
  readonly state: OperationState;
  admit(request: AdmissionRequest): Promise<Admission>;
  run<T>(kind: OperationKind, options: RunOptions, work: (run: OperationRun) => Promise<T>): Promise<T>;
}

/** How long entering a state may take before the operation is abandoned (BAK-8). */
const drainMilliseconds = 30_000;

/** Routes the BAK-11 recovery session may use while a restore is failed. */
const recoveryRoutes = new Set(['GET /api/admin/session', 'POST /api/admin/restore']);

function isLockTimeout(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '55P03';
}

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/** `<dataDir>/restore-failed.json`, the BAK-11 marker file. */
export function restoreFailedMarker(context: Pick<AppContext, 'config'>) {
  return resolve(context.config.storage.dataDir, 'restore-failed.json');
}

export interface PostgresOperationsOptions {
  log?: OperationLog;
  pollMilliseconds?: number;
  /** How long an owner waits for the activity and write locks, and for its own requests to drain (30 s; shorter in tests). */
  lockTimeoutMilliseconds?: number;
  /** Test hooks (TEST-4): pause an owner between steps. */
  hooks?: {
    /** After the owner set the state to `backup` or `restore`, before it takes the write lock. */
    afterStateUpdate?(kind: OperationKind): Promise<void>;
  };
}

/** The BAK-12 shared operation lock of one process. */
export class PostgresOperations implements Operations {
  /** This process, as `control.operation.owner`. */
  readonly processId = randomUUID();
  private current: OperationState = 'idle';
  private client: pg.Client | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  /** In-flight `/api/` requests of this process (except health), which share the activity lease. */
  private active = 0;
  /** The abort controllers of the admitted requests and jobs in progress (BAK-12). */
  private readonly inProgress = new Set<AbortController>();
  private leaseHeld = false;
  private seen: { state: OperationState; generation: string } | undefined;
  private owning: { kind: OperationKind; abort: AbortController } | undefined;
  private poller: NodeJS.Timeout | undefined;
  private polling = false;
  private stopped = false;
  private readonly log: OperationLog;

  constructor(
    private readonly context: Pick<AppContext, 'config' | 'db'>,
    private readonly options: PostgresOperationsOptions = {},
  ) {
    this.log = options.log ?? { info: () => undefined, warn: () => undefined, error: () => undefined };
  }

  get state() {
    return this.current;
  }

  /**
   * Startup (BAK-12): opens the control connection, runs the startup steps on
   * it (migrations under the migration lock, `server/db.ts`), reads the shared
   * state, and starts following it. Call before listening.
   */
  async start(migrationLog: { info(message: string): void } = this.log) {
    const client = await this.connect();
    await migrateAtStartup(client, { log: migrationLog, restoreFailedMarker: restoreFailedMarker(this.context) });
    await this.serial(async (control) => this.apply(await this.read(control)));
    this.poller = setInterval(() => void this.follow(), this.options.pollMilliseconds ?? 1000);
    this.poller.unref();
  }

  async stop() {
    this.stopped = true;
    if (this.poller) clearInterval(this.poller);
    const client = this.client;
    this.client = undefined;
    await client?.end().catch(() => undefined);
  }

  private async connect() {
    const client = this.context.db.client();
    const lost = () => this.connectionLost(client);
    client.on('error', lost);
    client.on('end', lost);
    await client.connect();
    this.client = client;
    this.leaseHeld = false;
    return client;
  }

  /**
   * The control connection dropped, and with it every lock it held. An owner
   * fails its operation at once (BAK-12, "Owner connection loss"); every
   * process answers `503 maintenance` until it has reconnected.
   */
  private connectionLost(client: pg.Client) {
    if (this.client !== client) return;
    this.client = undefined;
    this.leaseHeld = false;
    if (this.owning) {
      this.log.error(`The control connection dropped during a ${this.owning.kind}; the ${this.owning.kind} fails.`);
      this.owning.abort.abort(new Error('The control connection dropped.'));
    } else if (!this.stopped) {
      this.log.warn('The control connection dropped; reconnecting.');
    }
    // The lease is gone: every request and job in progress stops with 503 (BAK-12).
    for (const controller of this.inProgress) controller.abort(new MaintenanceError());
  }

  /** Stops following and the poller only, keeping the control connection: a test hook for a paused process (TEST-4). */
  pauseFollowing() {
    if (this.poller) clearInterval(this.poller);
    this.poller = undefined;
  }

  /** Ends the control connection as if it had dropped (TEST-4). */
  async dropControlConnection() {
    const client = this.client;
    if (!client) return;
    this.connectionLost(client);
    await client.end().catch(() => undefined);
  }

  /** Calls on the control connection are serialized, in order (BAK-12). */
  private serial<T>(work: (client: pg.Client) => Promise<T>): Promise<T> {
    const run = this.queue.then(() => {
      if (!this.client) throw new MaintenanceError();
      return work(this.client);
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(client: pg.Client) {
    return control.readOperation(client);
  }

  /**
   * Sets the local state from the shared row. After a restore, or an operation
   * that ended between two reads, the pool is recreated before any request is
   * served, so no connection keeps state from the replaced schema.
   */
  private async apply(row: ControlRow) {
    const previous = this.seen;
    this.seen = { state: row.state, generation: String(row.generation) };
    if (this.owning) return;
    this.current = row.state;
    if (!previous || row.state !== 'idle') return;
    const restoreEnded = previous.state === 'restore' || previous.state === 'restore_failed';
    const missed = previous.generation !== String(row.generation);
    if (restoreEnded || missed) await this.context.db.close();
  }

  /** Following (BAK-12): reads the shared state every second, reconnects, and detects a failed owner. */
  async follow() {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      if (!this.client) await this.connect();
      await this.serial(async (client) => {
        const row = await this.read(client);
        if (!this.owning && (row.state === 'backup' || row.state === 'restore') && !await this.ownerAlive(client)) {
          await this.ownerFailed(client, row);
          return this.apply(await this.read(client));
        }
        return this.apply(row);
      });
    } catch (error) {
      if (!(error instanceof MaintenanceError)) this.log.warn(`Reading the operation state failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.polling = false;
    }
  }

  private async ownerAlive(client: pg.Client) {
    return control.operationLockHeld(client);
  }

  /**
   * Owner failure (BAK-12): a backup changed nothing and returns to `idle`; a
   * restore may have half replaced the data and becomes `restore_failed`, with
   * the BAK-11 marker. The conditional update lets only one process act.
   */
  private async ownerFailed(client: pg.Client, row: ControlRow) {
    if (row.state === 'backup') {
      await control.abandonBackup(client, row.generation);
      this.log.warn('The process running a backup stopped; the backup was abandoned.');
      return;
    }
    if (!await control.markRestoreFailed(client, row.generation)) return;
    await this.writeMarker(row.pre_restore_backup);
    this.log.error(`The process running a restore stopped; the data may be half restored. Pre-restore backup: ${row.pre_restore_backup ?? 'none'}.`);
  }

  async writeMarker(preRestoreBackup: string | null) {
    try {
      await writeFile(restoreFailedMarker(this.context), `${JSON.stringify({ preRestoreBackup, failedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      this.log.error(`The restore-failed marker could not be written: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Admission (BAK-12): takes the activity lease if this process does not hold
   * it, reads the shared state, and admits by state. A request that is not
   * admitted gets `503 maintenance` and never reaches its handler.
   */
  admit(request: AdmissionRequest): Promise<Admission> {
    // A restore admits nothing new; a process that already follows it answers at once
    // instead of queueing behind the owner's exclusive activity lock.
    if (this.current === 'restore' && !this.owning) return Promise.reject(new MaintenanceError());
    return this.serial(async (client) => {
      if (!this.leaseHeld) {
        try {
          await control.advisoryLock(client, 'activity', { shared: true, timeout: true });
        } catch (error) {
          if (isLockTimeout(error)) throw new MaintenanceError();
          throw error;
        }
        this.leaseHeld = true;
      }
      const row = await this.read(client);
      await this.apply(row);
      let recovery: Admission['recovery'];
      const admitted = row.state === 'idle' || row.state === 'backup'
        || (row.state === 'restore_failed' && Boolean(recovery = this.recoveryAdmission(row, request)));
      if (!admitted) {
        if (this.active === 0) await this.unlockLease(client);
        throw new MaintenanceError();
      }
      this.active += 1;
      const controller = new AbortController();
      this.inProgress.add(controller);
      let released = false;
      return {
        recovery,
        signal: controller.signal,
        release: () => {
          if (released) return;
          released = true;
          this.inProgress.delete(controller);
          this.active -= 1;
          if (this.active === 0) void this.serial((control) => this.unlockLease(control)).catch(() => undefined);
        },
      };
    });
  }

  private recoveryAdmission(row: ControlRow, request: AdmissionRequest) {
    if (!recoveryRoutes.has(request.routeKey) || !request.adminTokenHash) return undefined;
    if (!row.admin_session_hash || row.admin_session_hash !== request.adminTokenHash) return undefined;
    if (!row.admin_session_expires_at || row.admin_session_expires_at.getTime() <= Date.now()) return undefined;
    return { username: row.admin_username ?? '' };
  }

  private async unlockLease(client: pg.Client) {
    if (this.active !== 0 || !this.leaseHeld) return;
    this.leaseHeld = false;
    await control.advisoryUnlock(client, 'activity', true);
  }

  /** Waits until this process has no other request in progress (its own locks never block it, BAK-8). */
  private async drainLocal() {
    const deadline = Date.now() + (this.options.lockTimeoutMilliseconds ?? drainMilliseconds);
    while (this.active > 1) {
      if (Date.now() >= deadline) throw operationConflict(true);
      await wait(50);
    }
  }

  /**
   * Runs a backup or restore as the owner (BAK-12, "Starting an operation" and
   * "Finishing"): the operation lock (`409` when taken), the state update, for
   * a restore the activity lock exclusively, then the write lock exclusively,
   * each with a 30-second timeout (`409`, state reverted). Every exit releases
   * the locks in reverse order.
   */
  async run<T>(kind: OperationKind, options: RunOptions, work: (run: OperationRun) => Promise<T>): Promise<T> {
    const recovery = kind === 'restore' && options.recovery === true;
    const held: Array<'operation' | 'activity' | 'writes'> = [];
    const abort = new AbortController();
    let failedWith: { preRestoreBackup: string | null } | undefined;
    let started = false;
    let succeeded = false;
    let preRestoreBackup: string | null = null;
    const onControl = <R>(step: (client: pg.Client) => Promise<R>) => {
      if (abort.signal.aborted) return Promise.reject(abort.signal.reason);
      return this.serial(step);
    };
    try {
      const locked = await onControl((client) => control.tryAdvisoryLock(client, 'operation'));
      if (!locked) throw operationConflict();
      held.push('operation');
      const startedRow = await onControl((client) => (recovery
        ? control.startRecoveryRestore(client, this.processId, options.session?.tokenHash ?? null)
        : control.startOperation(client, { processId: this.processId, kind, session: options.session })));
      if (!startedRow) throw operationConflict();
      started = true;
      preRestoreBackup = startedRow.pre_restore_backup;
      this.owning = { kind, abort };
      this.current = kind;
      this.seen = { state: kind, generation: String(startedRow.generation) };
      await this.options.hooks?.afterStateUpdate?.(kind);

      try {
        if (kind === 'restore') {
          await this.drainLocal();
          await this.exclusive(onControl, 'activity');
          held.push('activity');
        }
        await this.exclusive(onControl, 'writes');
        held.push('writes');
      } catch (error) {
        if (isLockTimeout(error)) throw operationConflict(true);
        throw error;
      }

      const run: OperationRun = {
        signal: abort.signal,
        control: onControl,
        preRestoreBackup,
        setPreRestoreBackup: (name) => onControl((client) => control.setPreRestoreBackup(client, name)),
        fail: (name) => {
          failedWith = { preRestoreBackup: name };
        },
      };
      const result = await work(run);
      succeeded = true;
      return result;
    } finally {
      // A recovery restore that did not succeed, and a restore whose owner lost
      // its connection, end in restore_failed (BAK-11).
      const failed = failedWith
        ?? (started && kind === 'restore' && (abort.signal.aborted || (recovery && !succeeded)) ? { preRestoreBackup } : undefined);
      await this.finish(kind, { started, held, failed, abort });
    }
  }

  private async exclusive(onControl: <R>(step: (client: pg.Client) => Promise<R>) => Promise<R>, name: 'activity' | 'writes') {
    await onControl((client) => control.advisoryLock(client, name, { timeout: this.options.lockTimeoutMilliseconds ?? true }));
  }

  /**
   * Finishing (BAK-12): `idle` with the recovery columns cleared, or
   * `restore_failed` with them kept and the marker written (BAK-11); then the
   * locks in reverse order. Without a control connection the locks are gone
   * already, and a restore enters `restore_failed` locally.
   */
  private async finish(kind: OperationKind, outcome: {
    started: boolean;
    held: Array<'operation' | 'activity' | 'writes'>;
    failed: { preRestoreBackup: string | null } | undefined;
    abort: AbortController;
  }) {
    const lostConnection = outcome.abort.signal.aborted;
    const { failed } = outcome;
    try {
      if (outcome.started && !lostConnection) {
        await this.serial((client) => (failed ? control.finishFailed(client) : control.finishIdle(client)));
      }
      if (outcome.started && failed) await this.writeMarker(failed.preRestoreBackup);
      if (outcome.started && !failed && kind === 'restore') await rm(restoreFailedMarker(this.context), { force: true });
    } finally {
      for (const name of [...outcome.held].reverse()) {
        await this.serial((client) => control.advisoryUnlock(client, name)).catch(() => undefined);
      }
      this.owning = undefined;
      if (outcome.started) this.current = failed ? 'restore_failed' : 'idle';
      if (outcome.started) this.seen = { state: this.current, generation: this.seen?.generation ?? '0' };
    }
  }
}
