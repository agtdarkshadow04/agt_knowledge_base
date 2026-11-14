import { createHash } from 'node:crypto';
import yazl from 'yazl';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assertMatches, match, rejectsMatching } from './helpers.js';
import { buildBackupArchive, readBackupArchive, type BackupManifest } from '../backup-archive.js';

const limits = { maxBytes: 10 * 1024 * 1024, maxEntries: 16, maxUncompressedBytes: 10 * 1024 * 1024 };
const database = { tables: { app_users: [{ user_id: 'u1', display_name: 'Atlas' }], admin: [{ id: true, username: 'atlas' }] } };

function sha256(data: Buffer) {
  return createHash('sha256').update(data).digest('hex');
}

async function zip(entries: Array<{ name: string; data: Buffer; mode?: number }>) {
  const file = new yazl.ZipFile();
  for (const entry of entries) file.addBuffer(entry.data, entry.name, entry.mode ? { mode: entry.mode } : {});
  file.end();
  const chunks: Buffer[] = [];
  for await (const chunk of file.outputStream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

function manifestFor(files: Record<string, Buffer>, overrides: Partial<BackupManifest> = {}) {
  return Buffer.from(JSON.stringify({
    format: 'agt-knowledge-base-backup',
    formatVersion: 2,
    appVersion: '1.0.0',
    createdAt: '2026-11-01T00:00:00.000Z',
    migrations: ['001_initial'],
    files: Object.fromEntries(Object.entries(files).map(([name, data]) => [name, { sha256: sha256(data), bytes: data.length }])),
    ...overrides,
  }));
}

const databaseData = Buffer.from(JSON.stringify(database));

async function expectInvalid(archive: Buffer, message: RegExp | string, archiveLimits = limits) {
  await rejectsMatching(readBackupArchive(archive, archiveLimits), {
    statusCode: 400,
    error: 'invalid_backup', legacyCode: 'INVALID_BACKUP',
    message: match.stringMatching(message),
  });
}

describe('backup archives', () => {
  it('round-trips the database, config.yaml, and a manifest with checksums', async () => {
    const archive = await buildBackupArchive({
      appVersion: '1.0.0',
      createdAt: '2026-11-01T00:00:00.000Z',
      migrations: ['001_initial', '002_article_revisions'],
      database,
      configText: 'server:\n  port: 3001\n',
    });
    const contents = await readBackupArchive(archive, limits);
    assert.deepEqual(contents.database, database);
    assert.equal(contents.configText, 'server:\n  port: 3001\n');
    assertMatches(contents.manifest, { format: 'agt-knowledge-base-backup', formatVersion: 2, migrations: ['001_initial', '002_article_revisions'] });
    assert.deepEqual(Object.keys(contents.manifest.files).sort(), ['config.yaml', 'database.json']);
    assert.equal(contents.manifest.files['database.json'].sha256, sha256(databaseData));
  });

  it('omits config.yaml when the installation has none', async () => {
    const archive = await buildBackupArchive({ appVersion: '1.0.0', createdAt: '2026-11-01T00:00:00.000Z', migrations: ['001_initial'], database, configText: null });
    assertMatches(await readBackupArchive(archive, limits), { configText: null });
  });

  it('rejects JSON backups from earlier versions and files that are not ZIP archives', async () => {
    await expectInvalid(Buffer.from('{"format":"agt-knowledge-base-backup","formatVersion":1}'), /JSON backups from earlier versions are not supported/);
    await expectInvalid(Buffer.from('not a zip at all'), /not a ZIP archive/);
    await expectInvalid(Buffer.from('PK\u0003\u0004 truncated'), /not a valid ZIP archive/);
  });

  it('rejects checksum mismatches and files missing from or added to the manifest', async () => {
    const tampered = Buffer.from(JSON.stringify({ tables: { admin: [] } }));
    await expectInvalid(await zip([
      { name: 'manifest.json', data: manifestFor({ 'database.json': databaseData }) },
      { name: 'database.json', data: tampered },
    ]), /checksum of database.json does not match/);
    await expectInvalid(await zip([
      { name: 'manifest.json', data: manifestFor({ 'database.json': databaseData }) },
      { name: 'database.json', data: databaseData },
      { name: 'config.yaml', data: Buffer.from('a: 1') },
    ]), /files do not match the manifest/);
    await expectInvalid(await zip([{ name: 'database.json', data: databaseData }]), /no manifest.json/);
  });

  it('rejects unexpected paths, path traversal, directories, and symlinks', async () => {
    const manifest = manifestFor({ 'database.json': databaseData });
    await expectInvalid(await zip([{ name: 'manifest.json', data: manifest }, { name: 'payload.sh', data: Buffer.from('x') }]), /unexpected entry/);
    await expectInvalid(await zip([{ name: 'manifest.json', data: manifest }, { name: 'nested/database.json', data: databaseData }]), /unexpected entry/);
    await expectInvalid(await zip([{ name: 'manifest.json', data: manifest }, { name: 'config.yaml', data: Buffer.from('/etc/passwd'), mode: 0o120777 }]), /unexpected entry/);

    // yazl refuses to write traversal paths, so rename an entry in place: "aa/database.json" -> "../database.json".
    const forged = await zip([{ name: 'manifest.json', data: manifest }, { name: 'aa/database.json', data: databaseData }]);
    const traversal = Buffer.from(forged.toString('latin1').replaceAll('aa/database.json', '../database.json'), 'latin1');
    await expectInvalid(traversal, /unexpected entry|corrupt|not a valid ZIP/);
  });

  it('enforces the entry-count, upload-size, and uncompressed-size limits', async () => {
    const archive = await buildBackupArchive({ appVersion: '1.0.0', createdAt: '2026-11-01T00:00:00.000Z', migrations: ['001_initial'], database, configText: 'a: 1\n' });
    await expectInvalid(archive, /at most 2 are allowed/, { ...limits, maxEntries: 2 });
    await expectInvalid(archive, /exceeds the backup size limit/, { ...limits, maxBytes: archive.length - 1 });

    // A highly compressible payload: small on disk, large once inflated.
    const bomb = Buffer.alloc(2 * 1024 * 1024, 0x20);
    const bombArchive = await zip([{ name: 'manifest.json', data: manifestFor({ 'database.json': bomb }) }, { name: 'database.json', data: bomb }]);
    assert.ok((bombArchive.length) < 64 * 1024);
    await expectInvalid(bombArchive, /uncompressed contents exceed the size limit/, { ...limits, maxUncompressedBytes: 1024 * 1024 });
  });

  it('refuses archives from a newer format version or another application', async () => {
    await expectInvalid(await zip([
      { name: 'manifest.json', data: manifestFor({ 'database.json': databaseData }, { formatVersion: 3 as 2 }) },
      { name: 'database.json', data: databaseData },
    ]), /newer version/);
    await expectInvalid(await zip([
      { name: 'manifest.json', data: manifestFor({ 'database.json': databaseData }, { format: 'agt-calendar-backup' as 'agt-knowledge-base-backup' }) },
      { name: 'database.json', data: databaseData },
    ]), /not an AGT Knowledge Base backup/);
  });

  it('rejects invalid table names in database.json', async () => {
    const data = Buffer.from(JSON.stringify({ tables: { 'articles; DROP TABLE x': [] } }));
    await expectInvalid(await zip([
      { name: 'manifest.json', data: manifestFor({ 'database.json': data }) },
      { name: 'database.json', data },
    ]), /database.json is invalid/);
  });
});
