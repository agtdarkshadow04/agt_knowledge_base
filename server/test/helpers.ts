import assert from 'node:assert/strict';
import { it, type Mock } from 'node:test';
import { asDataWrite } from '../dataWrite.js';
import { parseConfig, type AppConfig } from '../config.js';
import type { AppContext } from '../context.js';
import type { Database } from '../db.js';
import { errorReply, MaintenanceError } from '../http.js';
import type { AuditEntry, LogSink, ServerEntry } from '../logs.js';
import type { Operations, OperationState } from '../operation.js';
import type { ApiRequest, ApiResponse } from '../routes.js';

type AnyFunction = (...args: never[]) => unknown;

const matcherTag = Symbol('matcher');

interface Matcher {
  readonly [matcherTag]: true;
  readonly description: string;
  test(value: unknown): boolean;
}

function matcher(description: string, test: (value: unknown) => boolean): Matcher {
  return { [matcherTag]: true, description, test };
}

function isMatcher(value: unknown): value is Matcher {
  return typeof value === 'object' && value !== null && matcherTag in value;
}

/**
 * Placeholders for `assertMatches` and `assertCalledWith`, for values a test
 * cannot know exactly (generated IDs, timestamps).
 */
export const match = {
  any: (type: StringConstructor | NumberConstructor | BooleanConstructor | (abstract new (...args: never[]) => unknown)) => matcher(
    `any(${type.name})`,
    (value) => {
      if (type === String) return typeof value === 'string';
      if (type === Number) return typeof value === 'number';
      if (type === Boolean) return typeof value === 'boolean';
      return value instanceof (type as abstract new (...args: never[]) => unknown);
    },
  ),
  anything: () => matcher('anything', (value) => value !== null && value !== undefined),
  stringContaining: (text: string) => matcher(`stringContaining(${JSON.stringify(text)})`, (value) => typeof value === 'string' && value.includes(text)),
  stringMatching: (pattern: RegExp | string) => matcher(
    `stringMatching(${pattern})`,
    (value) => typeof value === 'string' && (typeof pattern === 'string' ? new RegExp(pattern) : pattern).test(value),
  ),
  objectContaining: (expected: Record<string, unknown>) => matcher(`objectContaining(${describe(expected)})`, (value) => matches(value, expected)),
  arrayContaining: (expected: unknown[]) => matcher(
    `arrayContaining(${describe(expected)})`,
    (value) => Array.isArray(value) && expected.every((item) => value.some((candidate) => matches(candidate, item))),
  ),
  notArrayContaining: (expected: unknown[]) => matcher(
    `not.arrayContaining(${describe(expected)})`,
    (value) => Array.isArray(value) && !expected.some((item) => value.some((candidate) => matches(candidate, item))),
  ),
};

function describe(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, entry: unknown) => (isMatcher(entry) ? `<${entry.description}>` : entry));
  } catch {
    return String(value);
  }
}

/**
 * Whether `actual` matches `expected` as Vitest's `toMatchObject` does: objects
 * may have extra properties (Error properties such as `message` included),
 * arrays must have the same length with matching items, other values must be
 * equal, and `match.*` placeholders test their value.
 */
export function matches(actual: unknown, expected: unknown): boolean {
  if (isMatcher(expected)) return expected.test(actual);
  if (Object.is(actual, expected)) return true;
  if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
  if (expected instanceof RegExp) return actual instanceof RegExp && String(actual) === String(expected);
  if (Buffer.isBuffer(expected)) return Buffer.isBuffer(actual) && actual.equals(expected);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => matches(actual[index], item));
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null) return false;
    const source = actual as Record<string, unknown>;
    return Object.entries(expected).every(([key, value]) => key in source && matches(source[key], value));
  }
  return false;
}

/** Asserts `matches(actual, expected)`. */
export function assertMatches(actual: unknown, expected: unknown) {
  assert.ok(matches(actual, expected), `Expected ${describe(actual)} to match ${describe(expected)}`);
}

/** Asserts that `promise` rejects with an error that matches `expected` (see `matches`). */
export async function rejectsMatching(promise: Promise<unknown>, expected: Record<string, unknown>) {
  await assert.rejects(promise, (error: unknown) => {
    assertMatches(error, expected);
    return true;
  });
}

/** Asserts that `fn` throws an error that matches `expected` (see `matches`). */
export function throwsMatching(fn: () => unknown, expected: Record<string, unknown>) {
  assert.throws(fn, (error: unknown) => {
    assertMatches(error, expected);
    return true;
  });
}

/**
 * Asserts that a `mock.fn()` was called at least once with arguments equal to
 * `expected` (deep equality; `match.*` placeholders allowed).
 */
export function assertCalledWith(fn: Mock<AnyFunction>, ...expected: unknown[]) {
  const calls = fn.mock.calls.map((call) => call.arguments);
  const matched = calls.some((args) => equals(args, expected));
  assert.ok(matched, `Expected a call with ${describe(expected)}; calls were ${describe(calls)}`);
}

/** Deep equality with `match.*` placeholders, as Vitest's `toEqual` (undefined properties ignored). */
export function equals(actual: unknown, expected: unknown): boolean {
  if (isMatcher(expected)) return expected.test(actual);
  if (Object.is(actual, expected)) return true;
  if (expected instanceof Date) return actual instanceof Date && actual.getTime() === expected.getTime();
  if (Buffer.isBuffer(expected)) return Buffer.isBuffer(actual) && actual.equals(expected);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && actual.length === expected.length && expected.every((item, index) => equals(actual[index], item));
  }
  if (typeof expected === 'object' && expected !== null) {
    if (typeof actual !== 'object' || actual === null || Array.isArray(actual)) return false;
    const definedKeys = (value: object) => Object.entries(value).filter(([, entry]) => entry !== undefined).map(([key]) => key).sort();
    const keys = definedKeys(expected);
    if (describe(definedKeys(actual)) !== describe(keys)) return false;
    return keys.every((key) => equals((actual as Record<string, unknown>)[key], (expected as Record<string, unknown>)[key]));
  }
  return false;
}

/** Asserts `equals(actual, expected)`: deep equality that allows `match.*` placeholders. */
export function assertEquals(actual: unknown, expected: unknown) {
  assert.ok(equals(actual, expected), `Expected ${describe(actual)} to equal ${describe(expected)}`);
}

/** The arguments of the `index`-th call of a `mock.fn()`. */
export function callArgs(fn: Mock<AnyFunction>, index = 0): unknown[] {
  const call = fn.mock.calls[index];
  assert.ok(call, `Expected call #${index + 1}; there were ${fn.mock.callCount()}`);
  return call.arguments;
}

/** A `Database` whose pool is the given fake. */
const testConnection = { host: 'localhost', port: 5432, database: 'agt_knowledge_base', user: 'agt_knowledge_base', password: 'test-password', ssl: false };

export function fakeDatabase(pool: unknown, client: () => unknown = () => { throw new Error('No client in this test.'); }): Database {
  return {
    pool: async () => pool as Awaited<ReturnType<Database['pool']>>,
    close: async () => undefined,
    connection: () => ({ ...testConnection }),
    client: () => client() as ReturnType<Database['client']>,
  };
}

/** A database that fails the test if anything touches it. */
export const untouchedDatabase: Database = {
  pool: async () => {
    throw new Error('The database must not be used by this test.');
  },
  close: async () => undefined,
  connection: () => ({ ...testConnection }),
  client: () => {
    throw new Error('The database must not be used by this test.');
  },
};

/** A log store for tests: it records audit entries and serves the given server log entries. */
export function testLogs(server: ServerEntry[] = [], audit: AuditEntry[] = []) {
  const written: Array<Omit<AuditEntry, 'id' | 'at' | 'lastAt' | 'count'>> = [];
  const sink: LogSink & { written: typeof written; seen: number; cleared: number } = {
    written,
    seen: 0,
    cleared: 0,
    async audit(entry) { written.push(entry); },
    ipHash: (address) => (address ? `hash:${address}` : null),
    async listServer(_filters, _after, limit) { return server.slice(0, limit); },
    async listAudit(_filters, _after, limit) { return audit.slice(0, limit); },
    async summary() { return { unseenWarnings: 0, unseenErrors: 0 }; },
    async markSeen() { sink.seen += 1; },
    async clearServer() { sink.cleared += 1; return server.length; },
  };
  return sink;
}

/**
 * An operation lock for tests: admits every request while `state` allows it,
 * and runs operations at once without any database lock.
 */
export function testOperations(state: OperationState = 'idle'): Operations & { state: OperationState; admitted: number; released: number } {
  const operations = {
    state,
    admitted: 0,
    released: 0,
    async admit() {
      if (operations.state === 'restore' || operations.state === 'restore_failed') throw new MaintenanceError();
      operations.admitted += 1;
      return { signal: new AbortController().signal, release: () => { operations.released += 1; } };
    },
    async run<T>(_kind: string, _options: unknown, work: (run: never) => Promise<T>) {
      const run = {
        signal: new AbortController().signal,
        control: async () => { throw new Error('No control connection in this test.'); },
        setPreRestoreBackup: async () => undefined,
        fail: () => undefined,
        preRestoreBackup: null,
      };
      return work(run as never);
    },
  };
  return operations;
}

/** An app context for tests: default configuration, a database that must not be used, and test secrets. */
export function testContext(overrides: Partial<Omit<AppContext, 'config'>> & { config?: AppConfig | string } = {}): AppContext {
  const { config, ...rest } = overrides;
  return {
    config: typeof config === 'string' ? parseConfig(config) : config ?? parseConfig(''),
    configFile: { path: '/app/config.yaml', text: null },
    db: untouchedDatabase,
    setupPassword: null,
    version: '1.0.0',
    operations: testOperations(),
    logs: testLogs(),
    toolPath: '/usr/bin',
    ...rest,
  };
}

/**
 * Runs a route dispatcher and turns a thrown error into the response the app's
 * error handler would send, so dispatch tests can assert on status and body.
 */
export async function respond(handler: (request: ApiRequest) => Promise<ApiResponse>, request: ApiRequest): Promise<ApiResponse> {
  try {
    return await handler(request);
  } catch (error) {
    const reply = errorReply(error);
    return { statusCode: reply.statusCode, headers: reply.headers, body: reply.body };
  }
}

/**
 * `it()` for repository and service tests: each test body runs inside the
 * data-write mark of `withDataWrite()` (BAK-8), as a declared route's handler does.
 */
export function dataWriteIt(name: string, fn: () => Promise<unknown> | unknown) {
  return it(name, () => asDataWrite(async () => { await fn(); }));
}
