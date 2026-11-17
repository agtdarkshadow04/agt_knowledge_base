import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import http from 'node:http';
import pg from 'pg';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { createRequestHandler } from '../app.js';
import { BackupService } from '../backup.js';
import { connectionParameters } from '../db.js';
import type { ApiRequest } from '../routes.js';
import { createTestDatabase, createTestServer, testDatabaseUrl, type TestServer } from './postgres.js';

/**
 * Real-PostgreSQL tests (TEST-3, TEST-4): startup and migrations, a backup
 * round trip, the BAK-3 preview allowlist on real dumps, and the BAK-12
 * behaviour of two app instances on one database (each a `buildApp()` with
 * its own pool and control connection).
 */

const csrf = { 'x-agt-request': '1', 'content-type': 'application/json' };
const adminPassword = 'Admin-Password-1!';
const memberPassword = 'Member-Password-1!';
const servers: TestServer[] = [];

after(async () => {
  // Second processes first: the first one drops the database.
  for (const server of servers.reverse()) await server.close();
});

async function server(options: Parameters<typeof createTestServer>[0] = {}) {
  const created = await createTestServer(options);
  servers.push(created);
  return created;
}

function cookieFrom(reply: { headers: Record<string, unknown> }, name: string) {
  const cookies = ([] as string[]).concat((reply.headers['set-cookie'] as string | string[] | undefined) ?? []);
  const found = cookies.find((cookie) => cookie.startsWith(`${name}=`));
  assert.ok(found, `no ${name} cookie`);
  return found.split(';')[0];
}

async function setUp(target: TestServer) {
  const setup = await target.app.inject({
    method: 'POST', url: '/api/setup', headers: csrf,
    payload: { setupPassword: 'test-setup-password-1A!', username: 'keeper', password: adminPassword },
  });
  assert.equal(setup.statusCode, 201, setup.body);
  const admin = cookieFrom(setup, 'agt_knowledge_base_session');
  const user = await target.app.inject({
    method: 'POST', url: '/api/admin/users', headers: { ...csrf, cookie: admin },
    payload: { username: 'scribe', displayName: 'Scribe', role: 'Moderator', password: memberPassword },
  });
  assert.equal(user.statusCode, 201, user.body);
  const member = await signInMember(target);
  return { admin, member };
}

async function signInMember(target: TestServer) {
  const login = await target.app.inject({ method: 'POST', url: '/api/member/login', headers: csrf, payload: { username: 'scribe', password: memberPassword } });
  assert.equal(login.statusCode, 200, login.body);
  return cookieFrom(login, 'agt_knowledge_base_member_session');
}

function createArticle(target: TestServer, member: string, title: string) {
  return target.app.inject({
    method: 'POST', url: '/api/articles', headers: { ...csrf, cookie: member },
    payload: { title, content: 'How to find and use the portals across the galaxy.', tagIds: [], visibility: 'Public' },
  });
}

async function titles(target: TestServer) {
  const reply = await target.app.inject({ method: 'GET', url: '/api/articles?limit=100' });
  assert.equal(reply.statusCode, 200, reply.body);
  return (JSON.parse(reply.body) as { items: Array<{ title: string }> }).items.map((item) => item.title).sort();
}

/** A gate a test hook waits on. */
function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  let reached!: () => void;
  const arrived = new Promise<void>((resolve) => { reached = resolve; });
  return { opened, open, arrived, reached };
}

/** A request dispatcher that holds `routeKey` (by default `POST /api/articles`) at `held` until the test opens it. */
function holdingHandlers(held: ReturnType<typeof gate>, routeKey = 'POST /api/articles') {
  return (context: TestServer['context']) => {
    const handle = createRequestHandler(context);
    return async (request: ApiRequest) => {
      if (request.routeKey === routeKey) {
        held.reached();
        await held.opened;
      }
      return handle(request);
    };
  };
}

function backupArchive(target: TestServer, admin: string) {
  return target.app.inject({ method: 'GET', url: '/api/admin/backup', headers: { cookie: admin } });
}

function multipart(fields: Record<string, string>, file: Buffer) {
  const boundary = `----agt${Date.now()}`;
  const parts = Object.entries(fields).map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
  const body = Buffer.concat([
    Buffer.from(parts.join('')),
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="backup"; filename="backup.zip"\r\nContent-Type: application/zip\r\n\r\n`),
    file,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}

function restore(target: TestServer, admin: string, action: 'preview' | 'restore', archive: Buffer) {
  const form = multipart({ action }, archive);
  return target.app.inject({ method: 'POST', url: '/api/admin/restore', headers: { 'x-agt-request': '1', cookie: admin, 'content-type': form.contentType }, payload: form.body });
}

function unzip(archive: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(archive, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) return reject(error);
      const files = new Map<string, Buffer>();
      zip.on('entry', (entry: yauzl.Entry) => {
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError || !stream) return reject(streamError);
          const chunks: Buffer[] = [];
          stream.on('data', (chunk: Buffer) => chunks.push(chunk));
          stream.on('end', () => { files.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
        });
      });
      zip.on('end', () => resolve(files));
      zip.readEntry();
    });
  });
}

/** An archive with `dump` in place of the original's database dump, with a matching manifest (BAK-2). */
function rezip(files: Map<string, Buffer>, dump: Buffer): Promise<Buffer> {
  const manifest = JSON.parse(files.get('manifest.json')!.toString()) as { files: Array<{ path: string; size: number; sha256: string }> };
  for (const entry of manifest.files) {
    if (entry.path !== 'database.dump') continue;
    entry.size = dump.length;
    entry.sha256 = createHash('sha256').update(dump).digest('hex');
  }
  const zip = new yazl.ZipFile();
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2)), 'manifest.json');
  zip.addBuffer(dump, 'database.dump');
  if (files.has('config.yaml')) zip.addBuffer(files.get('config.yaml')!, 'config.yaml');
  zip.end();
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
  });
}

function connectionEnv(database: string) {
  const url = connectionParameters({ connectionString: testDatabaseUrl(), ssl: false });
  return { ...process.env, PGHOST: url.host, PGPORT: String(url.port), PGUSER: url.user, PGPASSWORD: url.password, PGDATABASE: database };
}

async function query(database: string, sql: string) {
  const url = connectionParameters({ connectionString: testDatabaseUrl(), ssl: false });
  const client = new pg.Client({ ...url, database });
  await client.connect();
  try {
    return await client.query(sql);
  } finally {
    await client.end();
  }
}


/** Loads a custom-format dump into an empty scratch database (whose own `public` schema it replaces). */
async function loadDump(database: string, dump: Buffer) {
  const directory = mkdtempSync(join(tmpdir(), 'agt-kb-dump-'));
  try {
    const dumpFile = join(directory, 'database.dump');
    writeFileSync(dumpFile, dump);
    await query(database, 'DROP SCHEMA public CASCADE');
    execFileSync('pg_restore', ['--no-owner', '--no-acl', '--exit-on-error', '--dbname', database, dumpFile], { env: connectionEnv(database) });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('startup on PostgreSQL (DATA-4, BAK-12)', () => {
  it('migrates an empty database and serves the health check', async () => {
    const a = await server();
    const health = await a.app.inject({ method: 'GET', url: '/api/health' });
    assert.deepEqual(JSON.parse(health.body), { status: 'ok' });
    const status = await a.app.inject({ method: 'GET', url: '/api/setup/status' });
    assert.equal(JSON.parse(status.body).adminExists, false);
  });

  it('starts two processes at the same moment on an empty database, each migration running once', async () => {
    const database = await createTestDatabase();
    try {
      const dataDir = mkdtempSync(join(tmpdir(), 'agt-kb-test-'));
      const [a, b] = await Promise.all([server({ database: database.name, dataDir }), server({ database: database.name, dataDir })]);
      for (const table of ['schema_migrations', 'control.schema_migrations', 'logs.schema_migrations']) {
        const { rows } = await query(database.name, `SELECT version, count(*)::int AS n FROM ${table} GROUP BY version HAVING count(*) > 1`);
        assert.deepEqual(rows, [], table);
      }
      await b.close();
      await a.close();
      rmSync(dataDir, { recursive: true, force: true });
    } finally {
      await database.drop();
    }
  });

  it('refuses to start when the control schema is newer than the app (BAK-12)', async () => {
    const a = await server();
    await query(a.database, 'INSERT INTO control.schema_migrations (version, name) VALUES (9999, \'from_the_future\')');
    await assert.rejects(createTestServer({ database: a.database, dataDir: a.dataDir }), /newer/);
  });

  it('ignores the same advisory key held in another database of the server (BAK-12)', async () => {
    const a = await server();
    const other = await createTestDatabase();
    const url = connectionParameters({ connectionString: testDatabaseUrl(), ssl: false });
    const client = new pg.Client({ ...url, database: other.name });
    await client.connect();
    try {
      await client.query("SELECT pg_advisory_lock(0, hashtext('agt_knowledge_base_writes'))");
      const { member } = await setUp(a);
      assert.equal((await createArticle(a, member, 'Written while another database holds the key')).statusCode, 201);
    } finally {
      await client.end();
      await other.drop();
    }
  });
});

describe('backup and restore on PostgreSQL (BAK-2..BAK-4, LOG-17)', () => {
  it('round-trips the data, dumps only public, keeps the logs and empties the sessions', async () => {
    const a = await server();
    const { admin, member } = await setUp(a);
    assert.equal((await createArticle(a, member, 'Portal Guide')).statusCode, 201);
    const backup = await backupArchive(a, admin);
    assert.equal(backup.statusCode, 200, backup.body);
    const files = await unzip(backup.rawPayload);
    // BAK-2, LOG-17: every dumped object is in public.
    const directory = mkdtempSync(join(tmpdir(), 'agt-kb-dump-'));
    try {
      writeFileSync(join(directory, 'database.dump'), files.get('database.dump')!);
      const list = execFileSync('pg_restore', ['--list', join(directory, 'database.dump')], { encoding: 'utf8' });
      const entries = list.split('\n').filter((line) => line && !line.startsWith(';'));
      for (const line of entries) assert.match(line, / public /, line);
      assert.ok(!entries.some((line) => /TABLE DATA public (member_)?sessions /.test(line)), 'session rows are never dumped');
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }

    assert.equal((await createArticle(a, member, 'Written after the backup')).statusCode, 201);
    const auditBefore = (await query(a.database, 'SELECT count(*)::int AS n FROM logs.audit_log')).rows[0].n as number;
    const preview = await restore(a, admin, 'preview', backup.rawPayload);
    assert.equal(preview.statusCode, 200, preview.body);
    assert.deepEqual(await titles(a), ['Portal Guide', 'Written after the backup'], 'a preview changes nothing');
    const restored = await restore(a, admin, 'restore', backup.rawPayload);
    assert.equal(restored.statusCode, 200, restored.body);
    assert.deepEqual(await titles(a), ['Portal Guide']);
    // BAK-4: everyone is signed out, the pre-restore backup exists, and the logs were left in place and appended to.
    const session = await a.app.inject({ method: 'GET', url: '/api/member/session', headers: { cookie: member } });
    assert.equal(session.statusCode, 401);
    assert.ok(readdirSync(join(a.dataDir, 'backups')).some((name) => name.startsWith('pre-restore-backup-') && name.endsWith('.zip')));
    const auditAfter = (await query(a.database, 'SELECT count(*)::int AS n FROM logs.audit_log')).rows[0].n as number;
    assert.ok(auditAfter > auditBefore, 'the restore appends to the audit log instead of replacing it');
    assert.equal(existsSync(join(a.dataDir, 'restore-failed.json')), false);
  });

  it('rejects dumps with disallowed objects before restoring anything (BAK-3)', async () => {
    const a = await server();
    const { admin, member } = await setUp(a);
    assert.equal((await createArticle(a, member, 'Kept')).statusCode, 201);
    const backup = await backupArchive(a, admin);
    const files = await unzip(backup.rawPayload);
    const cases: Record<string, string> = {
      function: 'CREATE FUNCTION evil() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$',
      trigger: "CREATE FUNCTION touch() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$; CREATE TRIGGER touched BEFORE UPDATE ON tags FOR EACH ROW EXECUTE FUNCTION touch()",
      view: 'CREATE VIEW everything AS SELECT * FROM articles',
      'unexpected schema': 'CREATE SCHEMA elsewhere; CREATE TABLE elsewhere.t (id int)',
      'unknown table': 'CREATE TABLE extra (id int)',
      'ACL entry': 'GRANT SELECT ON articles TO PUBLIC',
    };
    for (const [name, sql] of Object.entries(cases)) {
      const scratch = await createTestDatabase();
      try {
        await loadDump(scratch.name, files.get('database.dump')!);
        await query(scratch.name, sql);
        const dump = execFileSync('pg_dump', ['--format=custom', '--schema=public', '--schema=elsewhere', scratch.name], { env: connectionEnv(scratch.name) });
        const reply = await restore(a, admin, 'preview', await rezip(files, dump));
        assert.equal(reply.statusCode, 422, `${name}: ${reply.body}`);
        assert.equal(JSON.parse(reply.body).error, 'archive_rejected', name);
      } finally {
        await scratch.drop();
      }
    }
    // The preview database is empty after every preview, and the live data is unchanged.
    const { rows } = await query(`${a.database}_preview`, "SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public'");
    assert.equal(rows[0].n, 0);
    assert.deepEqual(await titles(a), ['Kept']);
  });
});

describe('two processes on one database (BAK-12)', () => {
  it('makes writes in the other process wait for a backup, which then holds all of a write or none of it', async () => {
    const paused = gate();
    const a = await server({ operations: { hooks: { afterStateUpdate: async () => { paused.reached(); await paused.opened; } } } });
    const b = await server({ database: a.database, dataDir: a.dataDir });
    const { admin } = await setUp(a);
    // Signing in writes too, so it happens before the backup.
    const memberOnB = await signInMember(b);
    const backup = backupArchive(a, admin);
    await paused.arrived;
    // The backup has set its state but not taken the write lock yet: a write in that gap waits.
    let written = false;
    const write = createArticle(b, memberOnB, 'Written during the backup').then((reply) => { written = true; return reply; });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(written, false, 'the write waits while the backup runs');
    // Reads keep working in the other process during a backup.
    assert.equal((await b.app.inject({ method: 'GET', url: '/api/articles' })).statusCode, 200);
    // A second operation in the other process conflicts.
    assert.equal((await backupArchive(b, admin)).statusCode, 409);
    paused.open();
    const archive = await backup;
    assert.equal(archive.statusCode, 200, archive.body);
    assert.equal((await write).statusCode, 201);
    // The backup ran before the write committed: it holds none of it.
    const scratch = await createTestDatabase();
    try {
      await loadDump(scratch.name, (await unzip(archive.rawPayload)).get('database.dump')!);
      assert.equal((await query(scratch.name, "SELECT count(*)::int AS n FROM articles WHERE title = 'Written during the backup'")).rows[0].n, 0);
    } finally {
      await scratch.drop();
    }
  });

  it('answers 503 maintenance in the other process during a restore, then serves the restored data without sessions', async () => {
    const paused = gate();
    let pausing = false;
    const a = await server({ operations: { hooks: { afterStateUpdate: async (kind) => { if (kind === 'restore' && pausing) { paused.reached(); await paused.opened; } } } } });
    const b = await server({ database: a.database, dataDir: a.dataDir });
    const { admin, member } = await setUp(a);
    assert.equal((await createArticle(a, member, 'Before')).statusCode, 201);
    const archive = (await backupArchive(a, admin)).rawPayload;
    assert.equal((await createArticle(a, member, 'After')).statusCode, 201);
    const memberOnB = await signInMember(b);
    pausing = true;
    const restoring = restore(a, admin, 'restore', archive);
    await paused.arrived;
    // B follows the shared state within its poll interval.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const during = await b.app.inject({ method: 'GET', url: '/api/articles' });
    assert.equal(during.statusCode, 503);
    assert.equal(JSON.parse(during.body).error, 'maintenance');
    assert.ok(during.headers['retry-after']);
    assert.deepEqual(JSON.parse((await b.app.inject({ method: 'GET', url: '/api/health' })).body), { status: 'maintenance' });
    paused.open();
    assert.equal((await restoring).statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual(await titles(b), ['Before']);
    assert.equal((await b.app.inject({ method: 'GET', url: '/api/member/session', headers: { cookie: memberOnB } })).statusCode, 401);
  });

  it('refuses a request that arrives before the process has seen a restore, without starting its handler (admission)', async () => {
    const held = gate();
    const a = await server();
    const { admin } = await setUp(a);
    const archive = (await backupArchive(a, admin)).rawPayload;
    // C holds a long request, so it holds the activity lease; then it stops polling.
    const c = await server({ database: a.database, dataDir: a.dataDir, app: { handlers: { request: holdingHandlers(held)(a.context) } } });
    const memberOnC = await signInMember(c);
    const long = createArticle(c, memberOnC, 'Held open');
    await held.arrived;
    c.operations.pauseFollowing();
    const restoring = restore(a, admin, 'restore', archive);
    // The restore commits its state and then waits for C's lease.
    await new Promise((resolve) => setTimeout(resolve, 500));
    const second = await c.app.inject({ method: 'GET', url: '/api/articles' });
    assert.equal(second.statusCode, 503, 'admitted against the shared state, not the stale local one');
    held.open();
    assert.equal((await long).statusCode, 201, 'the request in progress finishes before the restore');
    assert.equal((await restoring).statusCode, 200);
  });

  it('aborts the requests in progress with 503 when the control connection drops, and serves again after a new lease', async () => {
    const held = gate();
    const a = await server();
    await setUp(a);
    const b = await server({ database: a.database, dataDir: a.dataDir, app: { handlers: { request: holdingHandlers(held)(a.context) } } });
    const memberOnB = await signInMember(b);
    const request = createArticle(b, memberOnB, 'Never written');
    await held.arrived;
    await b.operations.dropControlConnection();
    const reply = await request;
    assert.equal(reply.statusCode, 503, reply.body);
    assert.equal(JSON.parse(reply.body).error, 'maintenance');
    held.open();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.deepEqual((await titles(a)).filter((title) => title === 'Never written'), [], 'the aborted write did not commit');
    // B reconnects on its next poll and serves again.
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal((await b.app.inject({ method: 'GET', url: '/api/articles' })).statusCode, 200);
  });

  it('returns the other process to idle when a backup owner loses its control connection', async () => {
    const paused = gate();
    const a = await server({ operations: { hooks: { afterStateUpdate: async () => { paused.reached(); await paused.opened; } } } });
    const b = await server({ database: a.database, dataDir: a.dataDir });
    const { admin } = await setUp(a);
    const memberOnB = await signInMember(b);
    const backup = backupArchive(a, admin);
    await paused.arrived;
    await a.operations.dropControlConnection();
    paused.open();
    assert.notEqual((await backup).statusCode, 200, 'the owner stops its own work');
    // B sees that nobody holds the operation lock and abandons the backup; writes go through again.
    const write = await createArticle(b, memberOnB, 'Written after the owner failed');
    assert.equal(write.statusCode, 201, write.body);
    const { rows } = await query(a.database, 'SELECT state FROM control.operation WHERE id = 1');
    assert.equal(rows[0].state, 'idle');
  });

  it('puts the other process in restore_failed, with the marker, when a restore owner loses its control connection', async () => {
    const paused = gate();
    let pausing = false;
    const a = await server({ operations: { hooks: { afterStateUpdate: async (kind) => { if (kind === 'restore' && pausing) { paused.reached(); await paused.opened; } } } } });
    const b = await server({ database: a.database, dataDir: a.dataDir });
    const { admin } = await setUp(a);
    const archive = (await backupArchive(a, admin)).rawPayload;
    pausing = true;
    const restoring = restore(a, admin, 'restore', archive);
    await paused.arrived;
    await a.operations.dropControlConnection();
    paused.open();
    assert.notEqual((await restoring).statusCode, 200);
    await new Promise((resolve) => setTimeout(resolve, 500));
    const { rows } = await query(a.database, 'SELECT state FROM control.operation WHERE id = 1');
    assert.equal(rows[0].state, 'restore_failed');
    assert.ok(existsSync(join(a.dataDir, 'restore-failed.json')), 'the marker file is written');
    assert.equal((await b.app.inject({ method: 'GET', url: '/api/articles' })).statusCode, 503);
    // A restart refuses while the failed state and the marker are there (BAK-11).
    await assert.rejects(createTestServer({ database: a.database, dataDir: a.dataDir }), /restore/);
  });

  it('does not finish starting a process while a backup runs, so it serves nothing until the backup ends', async () => {
    const paused = gate();
    const a = await server({ operations: { hooks: { afterStateUpdate: async () => { paused.reached(); await paused.opened; } } } });
    const { admin } = await setUp(a);
    const backup = backupArchive(a, admin);
    await paused.arrived;
    // Its startup runs the app migrations under the shared write lock, which waits for the backup.
    let started = false;
    const starting = server({ database: a.database, dataDir: a.dataDir }).then((created) => { started = true; return created; });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(started, false, 'the new process waits for the backup before it serves');
    paused.open();
    assert.equal((await backup).statusCode, 200);
    const c = await starting;
    const login = await c.app.inject({ method: 'POST', url: '/api/member/login', headers: csrf, payload: { username: 'scribe', password: memberPassword } });
    assert.equal(login.statusCode, 200, login.body);
  });
});

/** The test's own state of `control.operation`. */
async function operationState(database: string) {
  return (await query(database, 'SELECT state FROM control.operation WHERE id = 1')).rows[0].state as string;
}

async function signInAdmin(target: TestServer) {
  const login = await target.app.inject({ method: 'POST', url: '/api/admin/login', headers: csrf, payload: { username: 'keeper', password: adminPassword } });
  assert.equal(login.statusCode, 200, login.body);
  return cookieFrom(login, 'agt_knowledge_base_session');
}

/** Waits until `check` holds, polling every 50 ms, for at most `milliseconds`. */
async function eventually(check: () => Promise<boolean>, milliseconds = 5000) {
  const deadline = Date.now() + milliseconds;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('The condition did not hold in time.');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** A request that has not settled within `milliseconds`. */
async function stillPending(promise: Promise<unknown>, milliseconds = 1000) {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
  return !settled;
}

/** A crafted archive: the backup's dump loaded into a scratch database, changed by `sql`, and dumped again. */
async function craftedArchive(backup: Buffer, sql: string, options: { wholeDatabase?: boolean } = {}) {
  const files = await unzip(backup);
  const scratch = await createTestDatabase();
  try {
    await loadDump(scratch.name, files.get('database.dump')!);
    await query(scratch.name, sql);
    const dump = execFileSync('pg_dump', ['--format=custom', ...(options.wholeDatabase ? [] : ['--schema=public']), scratch.name], { env: connectionEnv(scratch.name) });
    return await rezip(files, dump);
  } finally {
    await scratch.drop();
  }
}

describe('restore previews on PostgreSQL (BAK-3)', () => {
  it('rejects, after restoring into the preview database, a newer schema, a missing table and an Admin hash that could never sign in', async () => {
    const a = await server();
    const { admin } = await setUp(a);
    const backup = (await backupArchive(a, admin)).rawPayload;
    const cases: Array<[string, string, string]> = [
      ['newer schema', "INSERT INTO schema_migrations (version, name) VALUES (9999, 'from_the_future')", 'newer_schema'],
      ['missing table', 'DROP TABLE tags CASCADE', 'missing_tables'],
      ['bad Admin hash', "UPDATE admin SET password_hash = 'scrypt$1$2$3$bad$hash'", 'invalid_admin'],
    ];
    for (const [name, sql, reason] of cases) {
      const reply = await restore(a, admin, 'preview', await craftedArchive(backup, sql));
      assert.equal(reply.statusCode, 422, `${name}: ${reply.body}`);
      assert.equal(JSON.parse(reply.body).params?.reason, reason, name);
    }
  });

  it('rejects a dump with an extension before restoring anything (an event trigger needs a superuser; the allowlist tests cover its entry)', async () => {
    const a = await server();
    const { admin } = await setUp(a);
    const backup = (await backupArchive(a, admin)).rawPayload;
    const reply = await restore(a, admin, 'preview', await craftedArchive(backup, 'CREATE EXTENSION IF NOT EXISTS pgcrypto', { wholeDatabase: true }));
    assert.equal(reply.statusCode, 422, reply.body);
    assert.equal(JSON.parse(reply.body).params?.reason, 'disallowed_entry');
  });

  it('answers a second preview at the same time with 409, and a process started meanwhile leaves the preview database alone', async () => {
    const paused = gate();
    let pausing = false;
    const a = await server({
      backupTools: (real) => async (tool, args, options) => {
        const result = await real(tool, args, options);
        // Pause after the dump is in the preview database, before the checks and the emptying.
        if (pausing && tool === 'pg_restore' && args.some((arg) => arg.endsWith('_preview'))) { paused.reached(); await paused.opened; }
        return result;
      },
    });
    const { admin } = await setUp(a);
    const backup = (await backupArchive(a, admin)).rawPayload;
    pausing = true;
    const first = restore(a, admin, 'preview', backup);
    await paused.arrived;
    const second = await restore(a, admin, 'preview', backup);
    assert.equal(second.statusCode, 409, second.body);
    // A process starting now must not empty the preview database under the running preview.
    const c = await server({ database: a.database, dataDir: a.dataDir });
    await new BackupService(c.context).cleanPreviewDatabase();
    const tables = await query(`${a.database}_preview`, "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
    assert.ok(tables.rows[0].n > 0, 'the paused preview keeps its tables');
    paused.open();
    assert.equal((await first).statusCode, 200);
    const after = await query(`${a.database}_preview`, "SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = 'public'");
    assert.equal(after.rows[0].n, 0, 'the preview database is empty afterwards');
  });
});

describe('rollback and recovery on PostgreSQL (BAK-10, BAK-11)', () => {
  it('rolls back to exactly the original rows with the rollback list, and deletes each list with its pre-restore backup', async () => {
    let failNextLiveRestore = false;
    const a = await server({
      config: 'backup:\n  preRestore:\n    keep: 1',
      backupTools: (real) => async (tool, args, options) => {
        const result = await real(tool, args, options);
        if (failNextLiveRestore && tool === 'pg_restore' && args.includes('--clean')) {
          failNextLiveRestore = false;
          throw new Error('Injected failure after the live restore.');
        }
        return result;
      },
    });
    const { admin, member } = await setUp(a);
    assert.equal((await createArticle(a, member, 'In the backup')).statusCode, 201);
    const backup = (await backupArchive(a, admin)).rawPayload;
    assert.equal((await createArticle(a, member, 'Only live')).statusCode, 201);
    const before = (await query(a.database, 'SELECT id, title, version FROM articles ORDER BY id')).rows;

    failNextLiveRestore = true;
    const failed = await restore(a, admin, 'restore', backup);
    assert.equal(failed.statusCode, 500, failed.body);
    assert.match(JSON.parse(failed.body).message, /rolled back/);
    assert.deepEqual((await query(a.database, 'SELECT id, title, version FROM articles ORDER BY id')).rows, before, 'exactly the original rows');
    assert.equal(await operationState(a.database), 'idle');
    const firstFiles = readdirSync(join(a.dataDir, 'backups')).filter((name) => name.startsWith('pre-restore-backup-')).sort();
    assert.equal(firstFiles.length, 2, 'the pre-restore backup and its rollback list');
    assert.ok(firstFiles.some((name) => name.endsWith('.list')));

    // The next restore keeps only its own pre-restore backup (backup.preRestore.keep: 1), with its list.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const adminAgain = await signInAdmin(a);
    const succeeded = await restore(a, adminAgain, 'restore', backup);
    assert.equal(succeeded.statusCode, 200, succeeded.body);
    const files = readdirSync(join(a.dataDir, 'backups')).filter((name) => name.startsWith('pre-restore-backup-')).sort();
    assert.equal(files.length, 2);
    for (const name of firstFiles) assert.ok(!files.includes(name), `${name} was deleted with its pre-restore backup`);
  });

  it('lets only the recovery session see and restore a failed restore, from another process, until a good restore returns everyone to idle', async () => {
    const paused = gate();
    let pausing = false;
    let failRecovery = false;
    const a = await server({ operations: { hooks: { afterStateUpdate: async (kind) => { if (kind === 'restore' && pausing) { paused.reached(); await paused.opened; } } } } });
    const b = await server({
      database: a.database,
      dataDir: a.dataDir,
      backupTools: (real) => async (tool, args, options) => {
        if (failRecovery && tool === 'pg_restore' && args.includes('--clean')) throw new Error('Injected recovery failure.');
        return real(tool, args, options);
      },
    });
    const { admin, member } = await setUp(a);
    assert.equal((await createArticle(a, member, 'Recovered')).statusCode, 201);
    const backup = (await backupArchive(a, admin)).rawPayload;
    const other = await signInAdmin(a);
    pausing = true;
    const restoring = restore(a, admin, 'restore', backup);
    await paused.arrived;
    await a.operations.dropControlConnection();
    paused.open();
    await restoring;
    await eventually(async () => (await operationState(a.database)) === 'restore_failed');
    await eventually(async () => b.operations.state === 'restore_failed');

    // BAK-11: the recovery session (the one that started the restore) works for the session and restore routes only.
    const session = await b.app.inject({ method: 'GET', url: '/api/admin/session', headers: { cookie: admin } });
    assert.equal(session.statusCode, 200, session.body);
    assert.equal(JSON.parse(session.body).username, 'keeper');
    assert.equal((await b.app.inject({ method: 'GET', url: '/api/admin/session', headers: { cookie: other } })).statusCode, 503);
    assert.equal((await b.app.inject({ method: 'GET', url: '/api/admin/users', headers: { cookie: admin } })).statusCode, 503);
    assert.equal((await restore(b, other, 'restore', backup)).statusCode, 503, 'another session cannot start a recovery');

    // A recovery restore that fails leaves restore_failed, the marker and the recovery session as they were.
    failRecovery = true;
    assert.equal((await restore(b, admin, 'restore', backup)).statusCode, 500);
    assert.equal(await operationState(a.database), 'restore_failed');
    assert.ok(existsSync(join(a.dataDir, 'restore-failed.json')));
    assert.equal((await b.app.inject({ method: 'GET', url: '/api/admin/session', headers: { cookie: admin } })).statusCode, 200);

    // A good recovery restore, previewed first, returns to idle and clears the marker; no advisory lock stays held.
    failRecovery = false;
    assert.equal((await restore(b, admin, 'preview', backup)).statusCode, 200);
    const recovered = await restore(b, admin, 'restore', backup);
    assert.equal(recovered.statusCode, 200, recovered.body);
    assert.equal(await operationState(a.database), 'idle');
    assert.equal(existsSync(join(a.dataDir, 'restore-failed.json')), false);
    await eventually(async () => b.operations.state === 'idle');
    const locks = await query(a.database, "SELECT count(*)::int AS n FROM pg_locks l JOIN pg_database d ON d.oid = l.database WHERE l.locktype = 'advisory' AND d.datname = current_database() AND l.objid <> 0 AND l.granted");
    const held = locks.rows[0].n as number;
    assert.equal(held, 0, 'no advisory lock is held after the recovery');
    assert.deepEqual(await titles(b), ['Recovered']);
  });
});

describe('the drain across two processes (BAK-8, BAK-12)', () => {
  it('includes in the backup a write already in progress in a paused follower, and gives up with 409 when one outlasts the lock timeout', async () => {
    const held = gate();
    const a = await server({ operations: { lockTimeoutMilliseconds: 1500 } });
    await setUp(a);
    const b = await server({ database: a.database, dataDir: a.dataDir, app: { handlers: { request: holdingHandlers(held)(a.context) } } });
    const memberOnB = await signInMember(b);
    const admin = await signInAdmin(a);

    // A write in progress in B, which then stops following: the backup waits for it and contains it.
    const write = createArticle(b, memberOnB, 'Written before the snapshot');
    await held.arrived;
    b.operations.pauseFollowing();
    const backup = backupArchive(a, admin);
    assert.equal(await stillPending(backup, 500), true, 'the backup waits for the write in progress');
    held.open();
    assert.equal((await write).statusCode, 201);
    const archive = await backup;
    assert.equal(archive.statusCode, 200, archive.body);
    const scratch = await createTestDatabase();
    try {
      await loadDump(scratch.name, (await unzip(archive.rawPayload)).get('database.dump')!);
      assert.equal((await query(scratch.name, "SELECT count(*)::int AS n FROM articles WHERE title = 'Written before the snapshot'")).rows[0].n, 1);
    } finally {
      await scratch.drop();
    }
  });

  it('gives up the backup with 409 and changes nothing when a write is held past the lock timeout, then frees the operation lock', async () => {
    const held = gate();
    const a = await server({ operations: { lockTimeoutMilliseconds: 1000 } });
    await setUp(a);
    const b = await server({ database: a.database, dataDir: a.dataDir, app: { handlers: { request: holdingHandlers(held)(a.context) } } });
    const memberOnB = await signInMember(b);
    const admin = await signInAdmin(a);
    const write = createArticle(b, memberOnB, 'Held past the timeout');
    await held.arrived;
    const backup = await backupArchive(a, admin);
    assert.equal(backup.statusCode, 409, backup.body);
    assert.equal(await operationState(a.database), 'idle');
    held.open();
    assert.equal((await write).statusCode, 201);
    // After the 409 the operation lock is free again, from the other process too.
    assert.equal((await backupArchive(b, admin)).statusCode, 200);
  });

  it('makes a restore wait for a held read, a running job and a download held open in the other process', async () => {
    const heldRead = gate();
    const a = await server();
    const { admin } = await setUp(a);
    const archive = (await backupArchive(a, admin)).rawPayload;
    const b = await server({ database: a.database, dataDir: a.dataDir, app: { handlers: { request: holdingHandlers(heldRead, 'GET /api/articles')(a.context) } } });

    // A read held open in B.
    const read = b.app.inject({ method: 'GET', url: '/api/articles' });
    await heldRead.arrived;
    let restoring = restore(a, admin, 'restore', archive);
    assert.equal(await stillPending(restoring), true, 'the restore waits for the read');
    heldRead.open();
    assert.equal((await read).statusCode, 200);
    assert.equal((await restoring).statusCode, 200);

    // A job (the log retention job) admitted in B.
    const adminAgain = await signInAdmin(a);
    await eventually(async () => b.operations.state === 'idle');
    const job = await b.operations.admit({ routeKey: 'job retention' });
    restoring = restore(a, adminAgain, 'restore', archive);
    assert.equal(await stillPending(restoring), true, 'the restore waits for the job');
    job.release();
    assert.equal((await restoring).statusCode, 200);

    // A download held open: a large server log export that the client stops reading.
    const third = await signInAdmin(a);
    await eventually(async () => b.operations.state === 'idle');
    await query(a.database, "INSERT INTO logs.server_log (id, at, level, source, message, details) SELECT gen_random_uuid(), now(), 'info', 'startup', repeat('x', 400), '{}'::jsonb FROM generate_series(1, 60000)");
    const address = await b.app.listen({ port: 0, host: '127.0.0.1' });
    const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      const request = http.get(`${address}/api/admin/logs/server/export?format=jsonl`, { headers: { cookie: third } }, resolve);
      request.on('error', reject);
    });
    assert.equal(response.statusCode, 200);
    response.pause();
    restoring = restore(a, third, 'restore', archive);
    assert.equal(await stillPending(restoring, 1500), true, 'the restore waits for the download');
    response.resume();
    await new Promise((resolve) => response.on('end', resolve));
    assert.equal((await restoring).statusCode, 200);
  });
});
