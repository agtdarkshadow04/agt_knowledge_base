import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, describe, it, mock } from 'node:test';
import {
  allowlistToc,
  backupFileName,
  BackupService,
  parseTocLine,
  postgresTools,
  toolMajorVersion,
  type ToolRunner,
} from '../backup.js';
import { MIGRATIONS } from '../db.js';
import { HttpError } from '../http.js';
import { hashPassword } from '../passwords.js';
import { safeArchivePath, writeZip } from '../zip.js';
import { fakeDatabase, match, rejectsMatching, testContext, testOperations } from './helpers.js';

const root = mkdtempSync(join(tmpdir(), 'agt-backup-'));
after(() => rmSync(root, { recursive: true, force: true }));

const latest = MIGRATIONS.at(-1)!.version;
const dumpBytes = Buffer.from('PGDMP fake custom-format dump');

/** A `pg_restore --list` of a real schema-18 dump, shortened. */
const toc = [
  ';',
  '; Archive created at 2026-11-15 23:17:33 UTC',
  ';',
  '5; 2615 2200 SCHEMA - public pg_database_owner',
  '3540; 0 0 COMMENT - SCHEMA public pg_database_owner',
  '224; 1259 18921 TABLE public admin agt_knowledge_base',
  '220; 1259 18765 TABLE public articles agt_knowledge_base',
  '218; 1259 18711 TABLE public schema_migrations agt_knowledge_base',
  '3537; 0 18921 TABLE DATA public admin agt_knowledge_base',
  '3373; 2606 18932 CONSTRAINT public admin admin_pkey agt_knowledge_base',
  '3357; 1259 18988 INDEX public articles_search_idx agt_knowledge_base',
  '3383; 2606 18782 FK CONSTRAINT public articles articles_created_by_fkey agt_knowledge_base',
  '230; 1259 19000 SEQUENCE public counter_seq agt_knowledge_base',
  '231; 0 0 SEQUENCE OWNED BY public counter_seq agt_knowledge_base',
  '3600; 0 0 SEQUENCE SET public counter_seq agt_knowledge_base',
  '3601; 2604 19001 DEFAULT public admin id agt_knowledge_base',
].join('\n');

describe('the table of contents allowlist (BAK-3)', () => {
  it('parses entry lines, multi-word types included', () => {
    assert.deepEqual(parseTocLine('3537; 0 18921 TABLE DATA public admin agt_knowledge_base'), {
      line: '3537; 0 18921 TABLE DATA public admin agt_knowledge_base', type: 'TABLE DATA', schema: 'public', name: 'admin',
    });
    assert.equal(parseTocLine('3383; 2606 18782 FK CONSTRAINT public articles articles_created_by_fkey agt')!.name, 'articles articles_created_by_fkey');
    assert.equal(parseTocLine('; comment'), null);
    assert.equal(parseTocLine(''), null);
  });

  it('keeps the expected tables, their data and their structure, and drops the public schema entry and its comment', () => {
    const { list, warnings } = allowlistToc(toc);
    const kept = list.trim().split('\n');
    assert.equal(kept.length, 11);
    assert.ok(!list.includes('SCHEMA - public'));
    assert.ok(!list.includes('COMMENT - SCHEMA public'));
    assert.ok(!list.includes('; Archive'));
    assert.deepEqual(warnings, []);
  });

  it('drops log and control entries with a warning', () => {
    const { list, warnings } = allowlistToc(`${toc}\n6; 2615 3000 SCHEMA - logs agt\n240; 1259 3001 TABLE logs server_log agt\n241; 1259 3002 TABLE control operation agt`);
    assert.ok(!list.includes('logs') && !list.includes('control'));
    assert.deepEqual(warnings, ['The dump contains log or control tables; they are ignored.']);
  });

  it('rejects anything else, naming the first entry', () => {
    for (const entry of [
      '225; 1255 19721 FUNCTION public evil() agt',
      '226; 1255 19722 PROCEDURE public evil() agt',
      '227; 2620 19723 TRIGGER public articles touch agt',
      '228; 1259 19724 VIEW public titles agt',
      '229; 3079 19725 EXTENSION - pgcrypto',
      '230; 0 0 ACL public TABLE articles agt',
      '231; 2618 19726 RULE public articles hide agt',
      '232; 3256 19727 POLICY public articles mine agt',
      '233; 1247 19728 TYPE public mood agt',
      '234; 1259 19729 TABLE public extra agt',
      '235; 1259 19730 TABLE other articles agt',
      '236; 2615 19731 SCHEMA - other agt',
      '237; 1259 19732 MATERIALIZED VIEW public titles agt',
      '238; 3466 19733 EVENT TRIGGER - stop agt',
      'garbage',
    ]) {
      assert.throws(() => allowlistToc(`${toc}\n${entry}`), (error: unknown) => (
        error instanceof HttpError && error.statusCode === 422 && error.error === 'archive_rejected' && error.message.includes(entry.trim())
      ), entry);
    }
  });
});

describe('archive names and tools (BAK-2, BAK-6)', () => {
  it('names backups agt-knowledge-base-backup-<timestamp>.zip', () => {
    assert.equal(backupFileName(new Date('2026-11-10T06:30:59.123Z')), 'agt-knowledge-base-backup-2026-11-10T06-30-59-123Z.zip');
  });

  it('reads the client major version', () => {
    assert.equal(toolMajorVersion('pg_dump (PostgreSQL) 16.15 (Ubuntu 16.15-0ubuntu0.24.04.1)'), 16);
    assert.equal(toolMajorVersion('nothing'), null);
  });

  it('accepts only relative POSIX archive paths (SEC-10)', () => {
    for (const path of ['manifest.json', 'uploads/a.webp']) assert.ok(safeArchivePath(path), path);
    for (const path of ['/etc/passwd', '../x', 'a/../b', 'a\\b', 'a//b', './a', '']) assert.ok(!safeArchivePath(path), path);
  });

  it('runs the tools as children with the password only in PGPASSWORD, and stops them on abort', async () => {
    const bin = join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    // A stand-in pg_dump that prints its arguments and environment, or sleeps.
    writeFileSync(join(bin, 'pg_dump'), '#!/bin/sh\nif [ "$1" = "--sleep" ]; then sleep 30; fi\necho "args:$*"\necho "password:$PGPASSWORD user:$PGUSER db:$PGDATABASE ssl:$PGSSLMODE"\n');
    chmodSync(join(bin, 'pg_dump'), 0o755);
    const tools = postgresTools({ host: 'db', port: 5432, database: 'agt_knowledge_base', user: 'agt_knowledge_base', password: 's3cret', ssl: false }, `${bin}:/usr/bin:/bin`);
    const { stdout } = await tools('pg_dump', ['--format=custom'], {});
    assert.match(stdout, /args:--format=custom\n/);
    assert.match(stdout, /password:s3cret user:agt_knowledge_base db:agt_knowledge_base ssl:disable/);
    assert.doesNotMatch(stdout.split('\n')[0], /s3cret/);
    const abort = new AbortController();
    const running = tools('pg_dump', ['--sleep'], { signal: abort.signal });
    abort.abort(new Error('stopped'));
    await assert.rejects(running, /stopped/);
    await assert.rejects(tools('pg_dump', ['--sleep'], { timeoutMilliseconds: 50 }), /took longer/);
  });
});

// --- The service, with fake tools and a fake preview database -----------------------

interface Fakes {
  tools: ToolRunner;
  calls: Array<{ tool: string; args: string[] }>;
  previewStatements: string[];
  controlStatements: string[];
  service: BackupService;
  operations: ReturnType<typeof testOperations>;
  closed: () => number;
}

function fakes(options: {
  config?: string;
  configText?: string | null;
  failRestore?: (args: string[]) => boolean;
  failDump?: boolean;
  serverVersion?: number;
  toolVersion?: number;
  previewLocked?: boolean;
  adminHash?: string;
  schemaVersion?: number;
  listing?: string;
} = {}): Fakes {
  const calls: Fakes['calls'] = [];
  const previewStatements: string[] = [];
  const controlStatements: string[] = [];
  let closed = 0;
  const tools: ToolRunner = async (tool, args) => {
    calls.push({ tool, args });
    if (args[0] === '--version') return { stdout: `${tool} (PostgreSQL) ${options.toolVersion ?? 16}.4` };
    if (args[0] === '--list') return { stdout: options.listing ?? toc };
    if (tool === 'pg_dump') {
      if (options.failDump) throw new Error('pg_dump failed: connection refused');
      writeFileSync(args.find((arg) => arg.startsWith('--file='))!.slice('--file='.length), dumpBytes);
      return { stdout: '' };
    }
    if (options.failRestore?.(args)) throw new Error('pg_restore failed: relation is in use');
    return { stdout: '' };
  };
  const rows = (sql: string) => {
    if (sql.startsWith('SHOW server_version_num')) return [{ server_version_num: String((options.serverVersion ?? 16) * 10_000 + 4) }];
    if (sql.startsWith('SELECT pg_try_advisory_lock')) return [{ locked: !options.previewLocked }];
    if (sql.includes('information_schema.tables')) {
      return ['app_users', 'local_users', 'tags', 'articles', 'article_revisions', 'settings', 'admin', 'sessions', 'member_sessions', 'schema_migrations'].map((table_name) => ({ table_name }));
    }
    if (sql.startsWith('SELECT version FROM schema_migrations')) {
      return MIGRATIONS.filter((migration) => migration.version <= (options.schemaVersion ?? latest)).map(({ version }) => ({ version }));
    }
    if (sql.startsWith('SELECT count(*)')) return [{ count: '2' }];
    if (sql.startsWith('SELECT password_hash FROM admin')) return [{ password_hash: options.adminHash ?? validHash }];
    if (sql.startsWith('SELECT key FROM settings')) return [{ key: 'site.title' }];
    return [];
  };
  const query = (log: string[]) => mock.fn(async (sql: string) => {
    log.push(sql);
    const result = rows(sql);
    return { rows: result, rowCount: result.length };
  });
  const lockClient = { query: query(controlStatements), release: () => undefined };
  const pool = { connect: async () => lockClient, query: query(controlStatements) };
  const previewClient = { query: query(previewStatements), connect: async () => undefined, end: async () => undefined, on: () => undefined };
  const db = { ...fakeDatabase(pool, () => previewClient), close: async () => { closed += 1; } };
  const operations = testOperations();
  operations.run = async (_kind, _options, work) => work({
    signal: new AbortController().signal,
    control: async (step) => step({ query: query(controlStatements) } as never),
    setPreRestoreBackup: async (name) => { controlStatements.push(`pre_restore_backup = ${name}`); },
    fail: (name) => { controlStatements.push(`fail ${name}`); },
    preRestoreBackup: 'pre-restore-backup-original.zip',
  });
  const dataDir = mkdtempSync(join(root, 'data-'));
  const context = testContext({
    config: `storage:\n  dataDir: ${dataDir}\n${options.config ?? ''}`,
    configFile: { path: '/app/config.yaml', text: options.configText === undefined ? 'site:\n  title: Field Archive\n' : options.configText },
    db,
    operations,
    version: '2.0.0',
  });
  const service = new BackupService(context, { values: async () => ({ 'backup.maxZipBytes': 10_000_000, 'backup.maxEntries': 10, 'backup.maxUncompressedBytes': 10_000_000 }) as never }, {
    tools,
    now: () => new Date('2026-11-10T06:30:59.123Z'),
  });
  return { tools, calls, previewStatements, controlStatements, service, operations, closed: () => closed };
}

let validHash = '';
beforeEach(async () => {
  validHash ||= await hashPassword('Permanent123!xyz');
});

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

/** Writes an archive; `files` are the entries besides manifest.json. */
async function archive(name: string, manifest: Record<string, unknown> | null, files: Array<[string, Buffer]>) {
  const path = join(root, name);
  rmSync(path, { force: true });
  const entries = files.map(([entryPath, data]) => ({ path: entryPath, data }));
  if (manifest) entries.unshift({ path: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) });
  await writeZip(path, entries, new Date());
  return path;
}

function manifestFor(files: Array<[string, Buffer]>, overrides: Record<string, unknown> = {}) {
  return {
    format: 'agt-knowledge-base-backup', formatVersion: 1, appVersion: '2.0.0', schemaVersion: latest,
    createdAt: '2026-11-10T06:30:59.123Z', files: files.map(([path, data]) => ({ path, size: data.length, sha256: sha256(data) })), ...overrides,
  };
}

const goodFiles: Array<[string, Buffer]> = [['database.dump', dumpBytes], ['config.yaml', Buffer.from('site:\n  title: Old Archive\n')]];

describe('BackupService.backup (BAK-2, BAK-9)', () => {
  it('dumps the public schema without session rows under the backup lock and returns the archive', async () => {
    const { service, calls } = fakes();
    const backup = await service.backup();
    assert.equal(backup.filename, 'agt-knowledge-base-backup-2026-11-10T06-30-59-123Z.zip');
    const chunks: Buffer[] = [];
    for await (const chunk of backup.stream) chunks.push(chunk as Buffer);
    const zip = join(root, 'downloaded.zip');
    writeFileSync(zip, Buffer.concat(chunks));
    const dump = calls.find((call) => call.tool === 'pg_dump' && call.args[0] !== '--version')!;
    assert.deepEqual(dump.args.slice(0, 6), [
      '--format=custom', '--schema=public', '--no-owner', '--no-privileges', '--exclude-table-data=sessions', '--exclude-table-data=member_sessions',
    ]);
    assert.ok(!dump.args.some((arg) => arg.includes('test-password')));
    // The archive restores in preview: the manifest lists the dump and config.yaml with their checksums.
    const preview = await fakes().service.preview(zip);
    assert.equal(preview.schemaVersion.backup, latest);
    assert.equal(preview.config.content, 'site:\n  title: Field Archive\n');
    assert.equal(backup.size, Buffer.concat(chunks).length);
  });

  it('refuses tools older than the server (BAK-6)', async () => {
    await rejectsMatching(fakes({ toolVersion: 15 }).service.backup(), { statusCode: 500, message: match.stringMatching(/pg_dump 15 is older than the PostgreSQL 16 server/) });
  });
});

describe('BackupService.preview (BAK-3, BAK-5, BAK-7)', () => {
  it('restores the dump into the preview database with the allowlisted list and reports counts, settings and the config.yaml diff', async () => {
    const { service, calls, previewStatements, controlStatements } = fakes({ config: 'site:\n  title: Locked\n' });
    const preview = await service.preview(await archive('good.zip', manifestFor(goodFiles), goodFiles));
    const restore = calls.find((call) => call.tool === 'pg_restore' && call.args[0].startsWith('--dbname='))!;
    assert.deepEqual(restore.args.slice(0, 5), ['--dbname=agt_knowledge_base_preview', '--no-owner', '--no-privileges', '--exit-on-error', '--single-transaction']);
    assert.ok(restore.args[5].startsWith('--use-list='));
    assert.deepEqual(previewStatements.slice(0, 2), ['DROP SCHEMA IF EXISTS public CASCADE', 'CREATE SCHEMA public']);
    assert.deepEqual(previewStatements.slice(-2), ['DROP SCHEMA IF EXISTS public CASCADE', 'CREATE SCHEMA public']);
    assert.ok(controlStatements[0].startsWith("SELECT pg_try_advisory_lock(0, hashtext('agt_knowledge_base_preview'))"));
    assert.ok(controlStatements.at(-1)!.startsWith("SELECT pg_advisory_unlock(0, hashtext('agt_knowledge_base_preview'))"));
    assert.equal(preview.counts.articles, 2);
    assert.equal(preview.counts.sessions, undefined);
    assert.deepEqual(preview.ignoredSettings, ['site.title']);
    assert.equal(preview.config.included, true);
    assert.ok(preview.config.diff!.some((line) => line.kind === '+' && line.text.includes('Old Archive')));
    assert.deepEqual(preview.migrations.upgrade, []);
  });

  it('refuses a 1.x archive with the agreed message', async () => {
    const legacy: Array<[string, Buffer]> = [['database.json', Buffer.from('{"tables":{}}')]];
    const path = await archive('legacy.zip', { format: 'agt-knowledge-base-backup', formatVersion: 2, migrations: ['001_initial'], files: {} }, legacy);
    await rejectsMatching(fakes().service.preview(path), {
      statusCode: 422, error: 'archive_rejected', message: 'This backup was made by AGT Knowledge Base 1.x. Restore it with version 1.x, then upgrade to 2.0.',
    });
    // Detected by layout, not by formatVersion.
    const layout = await archive('legacy-layout.zip', manifestFor(goodFiles, { formatVersion: 1, migrations: [] }), goodFiles);
    await rejectsMatching(fakes().service.preview(layout), { message: match.stringMatching(/1\.x/) });
  });

  it('rejects newer formats and schemas, bad checksums, unlisted or missing files, foreign entries and non-ZIP files', async () => {
    const cases: Array<[string, Record<string, unknown> | null, Array<[string, Buffer]>, RegExp]> = [
      ['newer-format.zip', manifestFor(goodFiles, { formatVersion: 2 }), goodFiles, /format version 2/],
      ['newer-schema.zip', manifestFor(goodFiles, { schemaVersion: latest + 1 }), goodFiles, /newer than this version/],
      ['checksum.zip', manifestFor([['database.dump', Buffer.from('other')], goodFiles[1]]), goodFiles, /checksum of database\.dump/],
      ['unlisted.zip', manifestFor([goodFiles[0]]), goodFiles, /config\.yaml is not listed/],
      ['missing.zip', manifestFor(goodFiles), [goodFiles[0]], /lists config\.yaml, which the archive does not contain/],
      ['no-manifest.zip', null, goodFiles, /no manifest\.json/],
      ['no-dump.zip', manifestFor([goodFiles[1]]), [goodFiles[1]], /no database\.dump/],
      ['foreign.zip', manifestFor(goodFiles), [...goodFiles, ['uploads/x.webp', Buffer.from('x')]], /unexpected entry/],
      ['format.zip', manifestFor(goodFiles, { format: 'agt-event-calendar-backup' }), goodFiles, /not an AGT Knowledge Base backup/],
      ['extra-field.zip', manifestFor(goodFiles, { extra: true }), goodFiles, /manifest\.json is invalid/],
    ];
    for (const [name, manifest, files, message] of cases) {
      await rejectsMatching(fakes().service.preview(await archive(name, manifest, files)), { statusCode: 422, error: 'archive_rejected', message: match.stringMatching(message) });
    }
    const text = join(root, 'text.zip');
    writeFileSync(text, 'hello');
    await rejectsMatching(fakes().service.preview(text), { statusCode: 422, message: match.stringMatching(/not a ZIP archive/) });
  });

  it('rejects a dump with a disallowed entry before touching the preview database', async () => {
    const { service, previewStatements } = fakes({ listing: `${toc}\n225; 1255 19721 FUNCTION public evil() agt` });
    await rejectsMatching(service.preview(await archive('function.zip', manifestFor(goodFiles), goodFiles)), { statusCode: 422, message: match.stringMatching(/FUNCTION public evil\(\)/) });
    assert.deepEqual(previewStatements, []);
  });

  it('rejects a dump that does not restore or whose Admin hash could never sign in, and always empties the preview database', async () => {
    const broken = fakes({ failRestore: (args) => args[0] === '--dbname=agt_knowledge_base_preview' });
    await rejectsMatching(broken.service.preview(await archive('broken.zip', manifestFor(goodFiles), goodFiles)), { statusCode: 422, message: match.stringMatching(/could not be restored/) });
    assert.deepEqual(broken.previewStatements.slice(-2), ['DROP SCHEMA IF EXISTS public CASCADE', 'CREATE SCHEMA public']);
    const badHash = fakes({ adminHash: 'plain-text' });
    await rejectsMatching(badHash.service.preview(await archive('hash.zip', manifestFor(goodFiles), goodFiles)), { statusCode: 422, message: match.stringMatching(/Admin password hash/) });
    const mismatch = fakes({ schemaVersion: latest - 1 });
    await rejectsMatching(mismatch.service.preview(await archive('mismatch.zip', manifestFor(goodFiles), goodFiles)), { statusCode: 422, message: match.stringMatching(/does not match the manifest/) });
  });

  it('answers 409 while another preview holds the preview lock', async () => {
    await rejectsMatching(fakes({ previewLocked: true }).service.preview(await archive('busy.zip', manifestFor(goodFiles), goodFiles)), { statusCode: 409, error: 'conflict' });
  });

  it('leaves nothing in the temporary directory (SEC-10)', async () => {
    const { service } = fakes();
    await service.preview(await archive('clean.zip', manifestFor(goodFiles), goodFiles)).catch(() => undefined);
    assert.deepEqual(readdirSync(join(service.backupsDirectory(), 'tmp')), []);
  });
});

describe('BackupService.restore (BAK-4, BAK-10, BAK-11)', () => {
  const session = { tokenHash: 'a'.repeat(64), username: 'atlas', expiresAt: new Date(Date.now() + 3_600_000) };

  it('writes the pre-restore backup and its own rollback list, replaces the database, migrates and ends every session', async () => {
    const { service, calls, controlStatements, closed } = fakes({ config: 'site:\n  title: Locked\n' });
    const report = await service.restore(await archive('restore.zip', manifestFor(goodFiles), goodFiles), session);
    assert.equal(report.preRestoreBackup, 'pre-restore-backup-2026-11-10T06-30-59-123Z.zip');
    const backups = service.backupsDirectory();
    assert.ok(existsSync(join(backups, report.preRestoreBackup!)));
    assert.equal(readFileSync(join(backups, 'pre-restore-backup-2026-11-10T06-30-59-123Z.list'), 'utf8'), allowlistToc(toc).list);
    assert.ok(controlStatements.includes(`pre_restore_backup = ${report.preRestoreBackup}`));
    const main = calls.find((call) => call.args[0] === '--dbname=agt_knowledge_base')!;
    assert.deepEqual(main.args.slice(1, 7), ['--clean', '--if-exists', '--single-transaction', '--no-owner', '--no-privileges', '--exit-on-error']);
    assert.ok(closed() >= 1);
    // Step 6.1, in one transaction: the locked settings and every session row.
    const begin = controlStatements.lastIndexOf('BEGIN');
    assert.deepEqual(controlStatements.slice(begin), [
      'BEGIN', 'DELETE FROM settings WHERE key = ANY($1::text[])', 'DELETE FROM sessions', 'DELETE FROM member_sessions', 'COMMIT',
    ]);
    assert.deepEqual(readdirSync(join(backups, 'tmp')), []);
  });

  it('rolls back to the pre-restore dump with its own list when the restore fails', async () => {
    let attempts = 0;
    const { service, calls, controlStatements } = fakes({ failRestore: (args) => args[0] === '--dbname=agt_knowledge_base' && attempts++ === 0 });
    await rejectsMatching(service.restore(await archive('rollback.zip', manifestFor(goodFiles), goodFiles), session), {
      statusCode: 500, message: 'The restore failed and was rolled back. Nothing was changed.',
    });
    const mains = calls.filter((call) => call.args[0] === '--dbname=agt_knowledge_base');
    assert.equal(mains.length, 2);
    assert.ok(mains[1].args.some((arg) => arg.endsWith('pre-restore-backup-2026-11-10T06-30-59-123Z.list')));
    assert.ok(mains[1].args.at(-1)!.endsWith('pre-restore.dump'));
    assert.ok(!controlStatements.some((sql) => sql.startsWith('fail')));
    assert.ok(!controlStatements.includes('DELETE FROM sessions'));
  });

  it('ends in restore_failed when the rollback fails too', async () => {
    const { service, controlStatements } = fakes({ failRestore: (args) => args[0] === '--dbname=agt_knowledge_base' });
    await rejectsMatching(service.restore(await archive('failed.zip', manifestFor(goodFiles), goodFiles), session), {
      statusCode: 500, message: match.stringMatching(/could not be rolled back/),
    });
    assert.ok(controlStatements.includes('fail pre-restore-backup-2026-11-10T06-30-59-123Z.zip'));
  });

  it('skips the pre-restore backup in a recovery restore and has nothing to roll back to', async () => {
    const { service, calls, controlStatements } = fakes({ failRestore: (args) => args[0] === '--dbname=agt_knowledge_base' });
    await rejectsMatching(service.restore(await archive('recovery.zip', manifestFor(goodFiles), goodFiles), session, true), {
      statusCode: 500, message: 'The restore failed. The app stays in maintenance.',
    });
    assert.equal(calls.filter((call) => call.tool === 'pg_dump' && call.args[0] !== '--version').length, 0);
    assert.ok(controlStatements.includes('fail pre-restore-backup-original.zip'));
  });

  it('changes nothing when the pre-restore backup fails', async () => {
    const { service, calls } = fakes({ failDump: true });
    await rejectsMatching(service.restore(await archive('pre.zip', manifestFor(goodFiles), goodFiles), session), {
      statusCode: 500, message: 'The pre-restore backup could not be written, so nothing was restored. Check storage.backupsDir.',
    });
    assert.ok(!calls.some((call) => call.args[0] === '--dbname=agt_knowledge_base'));
    assert.deepEqual(readdirSync(service.backupsDirectory()).filter((name) => name.startsWith('pre-restore')), []);
  });

  it('keeps backup.preRestore.keep pre-restore backups, deleting each older one with its list', async () => {
    const { service } = fakes({ config: 'backup:\n  preRestore:\n    keep: 1\n' });
    const directory = service.backupsDirectory();
    mkdirSync(directory, { recursive: true });
    for (const name of ['pre-restore-backup-2026-01-01T00-00-00-000Z', 'pre-restore-backup-2026-02-01T00-00-00-000Z']) {
      writeFileSync(join(directory, `${name}.zip`), '');
      writeFileSync(join(directory, `${name}.list`), '');
    }
    writeFileSync(join(directory, 'unrelated.zip'), '');
    await service.prunePreRestoreBackups(directory, 'pre-restore-backup-2026-02-01T00-00-00-000Z.zip');
    assert.deepEqual(readdirSync(directory).sort(), ['pre-restore-backup-2026-02-01T00-00-00-000Z.list', 'pre-restore-backup-2026-02-01T00-00-00-000Z.zip', 'unrelated.zip']);
  });
});
