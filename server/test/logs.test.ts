import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import { describe, it, mock } from 'node:test';
import { parseConfig } from '../config.js';
import { dataWriteScope } from '../db.js';
import {
  createLogger,
  csvCell,
  decodeLogCursor,
  encodeLogCursor,
  exportFileName,
  exportStream,
  LogStore,
  logStoreStream,
  normalizeAddress,
  serverEntryFromRecord,
  startRetention,
} from '../logs.js';
import type { ServerEntry } from '../repository/logs.js';
import { fakeDatabase } from './helpers.js';

type QueryFn = (sql: string, values?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;

/** A pool for the log store that records statements and answers coalescing with `coalesced`. */
function fakePool(options: { coalesced?: boolean; failInsert?: boolean } = {}) {
  const statements: Array<{ sql: string; values?: unknown[] }> = [];
  const query = mock.fn<QueryFn>(async (sql, values) => {
    statements.push({ sql, values });
    if (options.failInsert && sql.startsWith('INSERT INTO logs.server_log')) throw new Error('relation does not exist');
    if (sql.startsWith('SELECT value FROM logs.log_meta')) return { rows: [{ value: 'ab'.repeat(32) }], rowCount: 1 };
    if (sql.startsWith('UPDATE logs.audit_log')) return { rows: [], rowCount: options.coalesced ? 1 : 0 };
    if (sql.startsWith('DELETE')) return { rows: [], rowCount: 2 };
    return { rows: [], rowCount: 0 };
  });
  return { pool: { query }, statements };
}

describe('the server log stream (LOG-5, LOG-7, LOG-9)', () => {
  it('maps a pino record to an entry, keeping only the error name, message, stack and route', () => {
    const entry = serverEntryFromRecord({
      level: 50, time: Date.parse('2026-11-16T01:00:00Z'), pid: 1, hostname: 'vm', msg: 'Unhandled API error', reqId: 'request-1',
      source: 'http', route: '/api/articles/:id', req: { headers: { cookie: 'secret' } },
      err: { type: 'Error', message: 'boom', stack: 'Error: boom\n    at x', code: 'E_SECRET', config: { password: 'x' } },
    })!;
    assert.equal(entry.level, 'error');
    assert.equal(entry.source, 'http');
    assert.equal(entry.requestId, 'request-1');
    assert.equal(entry.at.toISOString(), '2026-11-16T01:00:00.000Z');
    assert.deepEqual(entry.details, { error: { name: 'Error', message: 'boom', stack: 'Error: boom\n    at x' }, route: '/api/articles/:id' });
    assert.doesNotMatch(JSON.stringify(entry), /secret|password/);
  });

  it('stores info and above only, and defaults the source', () => {
    assert.equal(serverEntryFromRecord({ level: 20, msg: 'debug' }), null);
    assert.equal(serverEntryFromRecord({ level: 10, msg: 'trace' }), null);
    assert.equal(serverEntryFromRecord({ level: 30, msg: 'Server listening' })!.source, 'server');
    assert.equal(serverEntryFromRecord({ level: 40, msg: 'x', reqId: 'r' })!.source, 'http');
    assert.equal(serverEntryFromRecord({ level: 60, msg: 'x', source: 'startup' })!.level, 'fatal');
  });

  it('sends stdout what server.logLevel allows and the log store info and above whatever it is', async () => {
    const lines = (level: string) => {
      const stdout: string[] = [];
      const stored: ServerEntry[] = [];
      const logger = createLogger(
        parseConfig(`server:\n  logLevel: ${level}\n`),
        new Writable({ write(chunk, _encoding, done) { stdout.push(String(chunk)); done(); } }),
        logStoreStream({ enqueue: (entry) => stored.push(entry) }),
      );
      logger.debug('a debug line');
      logger.info({ source: 'startup' }, 'an info line');
      logger.error('an error line');
      return { stdout, stored };
    };
    const quiet = lines('error');
    assert.deepEqual(quiet.stored.map((entry) => entry.message), ['an info line', 'an error line']);
    assert.equal(quiet.stdout.length, 1);
    const verbose = lines('debug');
    assert.equal(verbose.stdout.length, 3);
    assert.deepEqual(verbose.stored.map((entry) => entry.level), ['info', 'error']);
    assert.equal(lines('silent').stdout.length, 0);
  });

  it('redacts cookies and authorization headers (SRV-6)', () => {
    const stored: ServerEntry[] = [];
    const stdout: string[] = [];
    const logger = createLogger(parseConfig(''), new Writable({ write(chunk, _encoding, done) { stdout.push(String(chunk)); done(); } }), logStoreStream({ enqueue: (entry) => stored.push(entry) }));
    logger.info({ req: { headers: { cookie: 'agt_knowledge_base_session=token', authorization: 'Bearer x' } } }, 'request');
    assert.doesNotMatch(stdout.join(''), /token|Bearer/);
  });
});

describe('the log store (LOG-1..LOG-4, LOG-11, LOG-12)', () => {
  it('holds entries until it is opened, then writes them in batches outside any data write', async () => {
    const { pool, statements } = fakePool();
    const store = new LogStore(fakeDatabase(pool));
    store.enqueue(serverEntryFromRecord({ level: 30, msg: 'early' })!);
    assert.equal(statements.length, 0);
    await store.open();
    const insert = statements.find(({ sql }) => sql.startsWith('INSERT INTO logs.server_log'))!;
    assert.deepEqual(insert.values![4], ['early']);
    // A log written while a data write runs never joins its transaction.
    const client = { query: mock.fn(async () => ({ rows: [], rowCount: 0 })), release: () => undefined };
    await dataWriteScope.run({ client: client as never }, async () => {
      store.enqueue(serverEntryFromRecord({ level: 40, msg: 'during a write' })!);
      await store.flush();
    });
    assert.equal(client.query.mock.callCount(), 0);
    assert.ok(statements.some(({ values }) => JSON.stringify(values).includes('during a write')));
  });

  it('reports a failed write once and never throws (LOG-3)', async () => {
    const { pool } = fakePool({ failInsert: true });
    const report = mock.fn((_message: string) => undefined);
    const store = new LogStore(fakeDatabase(pool), { report });
    await store.open();
    store.enqueue(serverEntryFromRecord({ level: 30, msg: 'one' })!);
    await store.flush();
    store.enqueue(serverEntryFromRecord({ level: 30, msg: 'two' })!);
    await store.flush();
    assert.equal(report.mock.callCount(), 1);
    assert.match(report.mock.calls[0].arguments[0], /could not write the server log/);
  });

  it('hashes addresses with the stored key, the /64 of IPv6 and the IPv4 of a mapped address', async () => {
    const store = new LogStore(fakeDatabase(fakePool().pool));
    assert.equal(store.ipHash('203.0.113.7'), null);
    await store.open();
    const hash = store.ipHash('203.0.113.7')!;
    assert.match(hash, /^[0-9a-f]{16}$/);
    assert.equal(store.ipHash('::ffff:203.0.113.7'), hash);
    assert.equal(store.ipHash('2001:db8:1:2:aaaa::1'), store.ipHash('2001:db8:1:2:bbbb:cccc:dddd:eeee'));
    assert.notEqual(store.ipHash('2001:db8:1:3::1'), store.ipHash('2001:db8:1:2::1'));
    assert.equal(normalizeAddress('2001:db8:0:1::5'), '2001:db8:0:1::/64');
    assert.equal(normalizeAddress('::ffff:10.0.0.1'), '10.0.0.1');
  });

  it('inserts successes and coalesces repeated failures within 60 seconds', async () => {
    const base = {
      actorType: 'anonymous' as const, actor: null, ipHash: 'abc', client: 'api' as const, action: 'createAdminSession',
      method: 'POST', route: '/api/admin/login', targetType: null, targetId: null, statusCode: 401, requestId: 'r', details: {},
    };
    const fresh = fakePool();
    await new LogStore(fakeDatabase(fresh.pool)).audit({ ...base, outcome: 'success', statusCode: 200 });
    assert.ok(!fresh.statements.some(({ sql }) => sql.startsWith('UPDATE')));
    assert.ok(fresh.statements.some(({ sql }) => sql.startsWith('INSERT INTO logs.audit_log')));

    const repeated = fakePool({ coalesced: true });
    await new LogStore(fakeDatabase(repeated.pool)).audit({ ...base, outcome: 'denied' });
    const update = repeated.statements.find(({ sql }) => sql.startsWith('UPDATE logs.audit_log'))!;
    assert.match(update.sql, /interval '60 seconds'/);
    assert.deepEqual(update.values!.slice(0, 4), ['createAdminSession', 'denied', 401, 'abc']);
    assert.ok(!repeated.statements.some(({ sql }) => sql.startsWith('INSERT')));
  });

  it('applies retention by age, then by cap, failures first for the audit log (LOG-15)', async () => {
    const { pool, statements } = fakePool();
    const store = new LogStore(fakeDatabase(pool), { now: () => new Date('2026-11-16T00:00:00Z') });
    const deleted = await store.applyRetention({ serverRetentionDays: 30, serverMaxEntries: 1000, auditRetentionDays: 365, auditMaxEntries: 10000 });
    assert.deepEqual(deleted, { server: 4, audit: 4 });
    const sql = statements.map((statement) => statement.sql);
    assert.deepEqual(statements[0].values, [new Date('2026-10-17T00:00:00Z')]);
    assert.ok(sql.some((statement) => statement.includes("ORDER BY (outcome = 'success'), at, id")));
    assert.ok(!sql.some((statement) => /DELETE FROM logs\.audit_log\s*$/.test(statement)));
  });

  it('logs a retention run that deleted entries, and skips while paused', async () => {
    const info = mock.fn((_details: object, _message: string) => undefined);
    const store = { applyRetention: mock.fn(async () => ({ server: 3, audit: 0 })) };
    const settings = async () => ({ serverRetentionDays: 30, serverMaxEntries: 1000, auditRetentionDays: 365, auditMaxEntries: 10000 });
    const release = mock.fn();
    const running = startRetention(store, settings, { info, error: () => undefined }, async () => ({ release }));
    await running.first;
    running.stop();
    assertSource(info.mock.calls[0].arguments[0], 'retention');
    // BAK-12: each run is admitted under the activity lease and releases it when done.
    assert.equal(release.mock.callCount(), 1);
    const paused = startRetention(store, settings, { info, error: () => undefined }, async () => null);
    await paused.first;
    paused.stop();
    assert.equal(store.applyRetention.mock.callCount(), 1);
  });
});

function assertSource(details: object, source: string) {
  assert.equal((details as { source?: string }).source, source);
}

describe('exports and cursors (LOG-22, API-8)', () => {
  it('neutralizes spreadsheet formulas and quotes CSV cells', () => {
    assert.equal(csvCell('=HYPERLINK("x")'), `"'=HYPERLINK(""x"")"`);
    for (const start of ['+', '-', '@', '\t', '\r']) assert.ok(csvCell(`${start}1`).replace(/^"/, '').startsWith(`'${start}`), JSON.stringify(start));
    assert.equal(csvCell('plain'), 'plain');
    assert.equal(csvCell({ a: 1 }), '"{""a"":1}"');
    assert.equal(csvCell(null), '');
  });

  it('streams every page as JSON Lines or CSV', async () => {
    const rows = Array.from({ length: 501 }, (_, index) => ({ id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`, at: new Date(1_000_000 - index), message: `=${index}` }));
    const page = mock.fn(async (after: { at: string } | null, limit: number) => {
      const start = after ? rows.findIndex((row) => row.at.toISOString() === after.at) + 1 : 0;
      return rows.slice(start, start + limit);
    });
    const read = async (format: 'jsonl' | 'csv') => {
      let text = '';
      for await (const chunk of exportStream(page, format, ['id', 'at', 'message'])) text += String(chunk);
      return text;
    };
    const jsonl = (await read('jsonl')).trim().split('\n');
    assert.equal(jsonl.length, 501);
    assert.equal(JSON.parse(jsonl[0]).message, '=0');
    const csv = (await read('csv')).split('\r\n');
    assert.equal(csv[0], 'id,at,message');
    assert.ok(csv[1].endsWith(",'=0"));
  });

  it('names exports and round-trips cursors, refusing malformed ones', () => {
    assert.equal(exportFileName('audit', 'csv', new Date('2026-11-16T01:02:03.004Z')), 'agt-knowledge-base-audit-log-2026-11-16T01-02-03-004Z.csv');
    const entry = { at: new Date('2026-11-16T01:00:00Z'), id: '10000000-0000-4000-8000-000000000001' };
    assert.deepEqual(decodeLogCursor(encodeLogCursor(entry)), { at: entry.at.toISOString(), id: entry.id });
    for (const bad of ['nope', Buffer.from('[1,2]').toString('base64url'), Buffer.from('["x","y"]').toString('base64url')]) {
      assert.equal(decodeLogCursor(bad), null, bad);
    }
  });
});
