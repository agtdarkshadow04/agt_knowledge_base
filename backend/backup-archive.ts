import { createHash } from 'node:crypto';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { z } from 'zod';
import { AppError } from './domain.js';

export const backupFormat = 'agt-knowledge-base-backup';
export const backupFormatVersion = 2;

export const manifestFile = 'manifest.json';
export const databaseFile = 'database.json';
export const configFile = 'config.yaml';
/** The only paths an archive may contain. */
export const archivePaths: readonly string[] = [manifestFile, databaseFile, configFile];

export type BackupRow = Record<string, unknown>;

export interface DatabaseDump {
  /** Tables in foreign-key insert order, each with every stored column of every row. */
  tables: Record<string, BackupRow[]>;
}

export interface ArchiveLimits {
  maxBytes: number;
  maxEntries: number;
  maxUncompressedBytes: number;
}

const tableNamePattern = /^[a-z_][a-z0-9_]{0,62}$/;

const manifestSchema = z.object({
  format: z.literal(backupFormat),
  formatVersion: z.literal(backupFormatVersion),
  appVersion: z.string().max(100),
  createdAt: z.iso.datetime(),
  migrations: z.array(z.string().regex(/^[0-9a-z_]{1,200}$/)).min(1).max(1000),
  files: z.record(z.string(), z.object({
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    bytes: z.number().int().nonnegative(),
  }).strict()),
}).strict();

export type BackupManifest = z.output<typeof manifestSchema>;

const databaseSchema = z.object({
  tables: z.record(
    z.string().regex(tableNamePattern, 'Table names must be lowercase identifiers.'),
    z.array(z.record(z.string(), z.unknown())),
  ),
}).strict();

export interface BackupContents {
  manifest: BackupManifest;
  database: DatabaseDump;
  /** The backup's config.yaml, or null when the installation had none. */
  configText: string | null;
}

export function invalidBackup(message: string): never {
  throw new AppError(`The backup cannot be restored: ${message}`, 400, 'INVALID_BACKUP');
}

function sha256(data: Buffer) {
  return createHash('sha256').update(data).digest('hex');
}

/** Builds a backup ZIP: database.json, config.yaml if any, and a manifest with a SHA-256 per file. */
export async function buildBackupArchive(input: {
  appVersion: string;
  createdAt: string;
  migrations: string[];
  database: DatabaseDump;
  configText: string | null;
}): Promise<Buffer> {
  const files: Array<[string, Buffer]> = [[databaseFile, Buffer.from(JSON.stringify(input.database), 'utf8')]];
  if (input.configText !== null) files.push([configFile, Buffer.from(input.configText, 'utf8')]);
  const manifest: BackupManifest = {
    format: backupFormat,
    formatVersion: backupFormatVersion,
    appVersion: input.appVersion,
    createdAt: input.createdAt,
    migrations: input.migrations,
    files: Object.fromEntries(files.map(([name, data]) => [name, { sha256: sha256(data), bytes: data.length }])),
  };
  const zip = new yazl.ZipFile();
  const mtime = new Date(input.createdAt);
  zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), manifestFile, { mtime });
  for (const [name, data] of files) zip.addBuffer(data, name, { mtime });
  zip.end();
  const chunks: Buffer[] = [];
  for await (const chunk of zip.outputStream) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks);
}

function openZip(buffer: Buffer) {
  return new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('The archive could not be opened.'));
      else resolve(zip);
    });
  });
}

function isSymlink(entry: yauzl.Entry) {
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
}

/**
 * Reads every allowed entry, enforcing the entry-count and uncompressed-size
 * limits from the central directory and again while decompressing, so a
 * forged size cannot slip past them.
 */
async function readEntries(buffer: Buffer, limits: ArchiveLimits) {
  let zip: yauzl.ZipFile;
  try {
    zip = await openZip(buffer);
  } catch {
    invalidBackup('it is not a valid ZIP archive.');
  }
  if (zip.entryCount > limits.maxEntries) {
    zip.close();
    invalidBackup(`it contains ${zip.entryCount} entries; at most ${limits.maxEntries} are allowed.`);
  }
  const entries = new Map<string, Buffer>();
  let total = 0;
  return new Promise<Map<string, Buffer>>((resolve, reject) => {
    const fail = (error: unknown) => { zip.close(); reject(error); };
    const guard = (check: () => void) => {
      try { check(); return true; } catch (error) { fail(error); return false; }
    };
    zip.on('error', () => guard(() => invalidBackup('the ZIP archive is corrupt.')));
    zip.on('end', () => resolve(entries));
    zip.on('entry', (entry: yauzl.Entry) => {
      const name = entry.fileName;
      const ok = guard(() => {
        if (name.endsWith('/') || isSymlink(entry) || !archivePaths.includes(name)) {
          invalidBackup(`it contains an unexpected entry (${JSON.stringify(name.slice(0, 100))}).`);
        }
        if (entries.has(name)) invalidBackup(`it contains ${name} more than once.`);
        total += entry.uncompressedSize;
        if (total > limits.maxUncompressedBytes) invalidBackup('its uncompressed contents exceed the size limit.');
      });
      if (!ok) return;
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { guard(() => invalidBackup('the ZIP archive is corrupt.')); return; }
        const chunks: Buffer[] = [];
        let size = 0;
        stream.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > entry.uncompressedSize || size > limits.maxUncompressedBytes) {
            stream.destroy();
            guard(() => invalidBackup('its uncompressed contents exceed the size limit.'));
            return;
          }
          chunks.push(chunk);
        });
        stream.on('error', () => guard(() => invalidBackup('the ZIP archive is corrupt.')));
        stream.on('end', () => {
          entries.set(name, Buffer.concat(chunks));
          zip.readEntry();
        });
      });
    });
    zip.readEntry();
  });
}

function parseJson(data: Buffer, name: string): unknown {
  try {
    return JSON.parse(data.toString('utf8'));
  } catch {
    invalidBackup(`${name} is not valid JSON.`);
  }
}

/** Validates a backup archive and returns its contents. Nothing is written anywhere. */
export async function readBackupArchive(buffer: Buffer, limits: ArchiveLimits): Promise<BackupContents> {
  if (buffer.length > limits.maxBytes) invalidBackup('the file exceeds the backup size limit.');
  const firstByte = buffer.subarray(0, 64).toString('utf8').trimStart()[0];
  if (firstByte === '{') {
    invalidBackup('JSON backups from earlier versions are not supported. Create a new backup (a .zip archive) and restore that.');
  }
  if (buffer.subarray(0, 4).toString('latin1') !== 'PK\u0003\u0004') invalidBackup('it is not a ZIP archive.');

  const entries = await readEntries(buffer, limits);
  const manifestData = entries.get(manifestFile);
  if (!manifestData) invalidBackup(`it has no ${manifestFile}.`);
  const rawManifest = parseJson(manifestData, manifestFile);
  if (rawManifest && typeof rawManifest === 'object' && 'format' in rawManifest && rawManifest.format !== backupFormat) {
    invalidBackup('it is not an AGT Knowledge Base backup.');
  }
  if (rawManifest && typeof rawManifest === 'object' && 'formatVersion' in rawManifest
    && typeof rawManifest.formatVersion === 'number' && rawManifest.formatVersion > backupFormatVersion) {
    invalidBackup('it was created by a newer version of the application.');
  }
  const parsedManifest = manifestSchema.safeParse(rawManifest);
  if (!parsedManifest.success) invalidBackup(`${manifestFile} is invalid (${parsedManifest.error.issues[0].path.join('.') || 'root'}).`);
  const manifest = parsedManifest.data;

  const listed = Object.keys(manifest.files).sort();
  const present = [...entries.keys()].filter((name) => name !== manifestFile).sort();
  if (listed.join('\n') !== present.join('\n')) invalidBackup('its files do not match the manifest.');
  for (const name of present) {
    const data = entries.get(name)!;
    const expected = manifest.files[name];
    if (data.length !== expected.bytes || sha256(data) !== expected.sha256) {
      invalidBackup(`the checksum of ${name} does not match the manifest.`);
    }
  }
  const databaseData = entries.get(databaseFile);
  if (!databaseData) invalidBackup(`it has no ${databaseFile}.`);
  const database = databaseSchema.safeParse(parseJson(databaseData, databaseFile));
  if (!database.success) invalidBackup(`${databaseFile} is invalid.`);
  const configData = entries.get(configFile);
  return { manifest, database: database.data, configText: configData ? configData.toString('utf8') : null };
}
