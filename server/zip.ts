import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl from 'yauzl';
import yazl from 'yazl';

/**
 * Safe ZIP handling (SEC-10). Archives are read only here: absolute paths,
 * `.`/`..` segments, backslashes, symbolic links, directories, duplicates,
 * entries outside the allowlist, too many entries and too large a total
 * uncompressed size are all rejected, the last two from the central directory
 * and again while decompressing, so a forged size cannot slip past.
 */

export interface ZipLimits {
  maxEntries: number;
  maxUncompressedBytes: number;
}

export class ZipRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ZipRejectedError';
  }
}

export interface ExtractedEntry {
  path: string;
  /** Where the entry was written. */
  file: string;
  size: number;
  sha256: string;
}

/** A relative POSIX path without empty, `.` or `..` segments and without backslashes (BAK-2). */
export function safeArchivePath(path: string) {
  if (!path || path.startsWith('/') || path.includes('\\') || path.includes('\0')) return false;
  return path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
}

function openZip(file: string) {
  return new Promise<yauzl.ZipFile>((resolve, reject) => {
    yauzl.open(file, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true, autoClose: true }, (error, zip) => {
      if (error || !zip) reject(error ?? new Error('The archive could not be opened.'));
      else resolve(zip);
    });
  });
}

function isSymlink(entry: yauzl.Entry) {
  return ((entry.externalFileAttributes >>> 16) & 0o170000) === 0o120000;
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry) {
  return new Promise<Readable>((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => (error || !stream ? reject(error ?? new Error('unreadable entry')) : resolve(stream)));
  });
}

/**
 * Extracts every entry of the ZIP at `file` into `directory`, each under a
 * generated name, checking the allowlist (`allowed(path)`) and the limits.
 * Returns each entry's size and SHA-256. Nothing is written outside `directory`.
 */
export async function extractZip(file: string, directory: string, allowed: (path: string) => boolean, limits: ZipLimits): Promise<ExtractedEntry[]> {
  let zip: yauzl.ZipFile;
  try {
    zip = await openZip(file);
  } catch {
    throw new ZipRejectedError('It is not a valid ZIP archive.');
  }
  try {
    if (zip.entryCount > limits.maxEntries) {
      throw new ZipRejectedError(`It contains ${zip.entryCount} entries; at most ${limits.maxEntries} are allowed.`);
    }
    const entries: ExtractedEntry[] = [];
    const seen = new Set<string>();
    let declared = 0;
    let total = 0;
    for (;;) {
      const entry = await new Promise<yauzl.Entry | null>((resolve, reject) => {
        const onEntry = (value: yauzl.Entry) => { cleanup(); resolve(value); };
        const onEnd = () => { cleanup(); resolve(null); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const cleanup = () => {
          zip.off('entry', onEntry);
          zip.off('end', onEnd);
          zip.off('error', onError);
        };
        zip.on('entry', onEntry);
        zip.on('end', onEnd);
        zip.on('error', onError);
        zip.readEntry();
      }).catch(() => {
        throw new ZipRejectedError('The ZIP archive is corrupt.');
      });
      if (!entry) break;
      const path = entry.fileName;
      const shown = JSON.stringify(path.slice(0, 100));
      if (path.endsWith('/') || isSymlink(entry) || !safeArchivePath(path) || !allowed(path)) {
        throw new ZipRejectedError(`It contains an unexpected entry (${shown}).`);
      }
      if (seen.has(path)) throw new ZipRejectedError(`It contains ${shown} more than once.`);
      seen.add(path);
      declared += entry.uncompressedSize;
      if (declared > limits.maxUncompressedBytes) throw new ZipRejectedError('Its uncompressed contents exceed the size limit.');

      const target = join(directory, `entry-${entries.length}`);
      const hash = createHash('sha256');
      let size = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          size += chunk.length;
          total += chunk.length;
          if (size > entry.uncompressedSize || total > limits.maxUncompressedBytes) {
            callback(new ZipRejectedError('Its uncompressed contents exceed the size limit.'));
            return;
          }
          hash.update(chunk);
          callback(null, chunk);
        },
      });
      let stream: Readable;
      try {
        stream = await openEntry(zip, entry);
      } catch {
        throw new ZipRejectedError('The ZIP archive is corrupt.');
      }
      try {
        await pipeline(stream, counter, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
      } catch (error) {
        if (error instanceof ZipRejectedError) throw error;
        throw new ZipRejectedError('The ZIP archive is corrupt.');
      }
      entries.push({ path, file: target, size, sha256: hash.digest('hex') });
    }
    return entries;
  } finally {
    zip.close();
  }
}

/** SHA-256 and size of a file. */
export async function fileDigest(file: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return { size: (await stat(file)).size, sha256: hash.digest('hex') };
}

/** Writes a ZIP of `entries` (archive path → file or buffer) to `target`. */
export async function writeZip(target: string, entries: Array<{ path: string; file?: string; data?: Buffer }>, mtime: Date) {
  const zip = new yazl.ZipFile();
  for (const entry of entries) {
    if (!safeArchivePath(entry.path)) throw new Error(`Unsafe archive path ${entry.path}.`);
    if (entry.file !== undefined) zip.addFile(entry.file, entry.path, { mtime });
    else zip.addBuffer(entry.data ?? Buffer.alloc(0), entry.path, { mtime });
  }
  zip.end();
  await pipeline(zip.outputStream, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
}
