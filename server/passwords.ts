import { createHash, randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing (AUTH-2) for the Admin and members (AUTH-1 deviation).
 * Stored as `scrypt$N$r$p$<salt base64>$<hash base64>`. A stored hash is
 * checked before any scrypt call and can only verify with a supported profile.
 */

/** Every scrypt call passes fixed options; `maxmem` is never derived from a stored hash. */
const maxmem = 64 * 1024 * 1024;
const saltBytes = 16;
const keyBytes = 64;

interface Profile {
  N: number;
  r: number;
  p: number;
  /**
   * The 1.x profile: Node's default scrypt parameters, without NFKC
   * normalization. Migration 017 rewrote 1.x `scrypt$salt$hash` values into this
   * format; a successful sign-in rehashes them with the current profile.
   */
  legacy?: true;
}

/** The supported parameter profiles; the first is used for new hashes (AUTH-2). */
export const SCRYPT_PROFILES: readonly Profile[] = [
  { N: 32768, r: 8, p: 1 },
  { N: 16384, r: 8, p: 1, legacy: true },
];
const current = SCRYPT_PROFILES[0];

function scrypt(password: string, salt: Buffer, profile: Profile): Promise<Buffer> {
  const options: ScryptOptions = { N: profile.N, r: profile.r, p: profile.p, maxmem };
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, keyBytes, options, (error, key) => (error ? reject(error) : resolve(key)));
  });
}

function input(password: string, profile: Profile) {
  return profile.legacy ? password : password.normalize('NFKC');
}

const decimal = /^(0|[1-9][0-9]*)$/;
const base64 = /^[A-Za-z0-9+/]*={0,2}$/;

function decode(value: string, bytes: number) {
  if (!base64.test(value) || value.length % 4 !== 0) return null;
  const decoded = Buffer.from(value, 'base64');
  return decoded.length === bytes && decoded.toString('base64') === value ? decoded : null;
}

export interface ParsedHash {
  profile: Profile;
  salt: Buffer;
  hash: Buffer;
}

/** Checks a stored hash without calling scrypt (AUTH-2); null means it can never verify. */
export function parseHash(stored: string): ParsedHash | null {
  const fields = stored.split('$');
  if (fields.length !== 6 || fields[0] !== 'scrypt') return null;
  const [, N, r, p, saltValue, hashValue] = fields;
  if (![N, r, p].every((value) => decimal.test(value))) return null;
  const profile = SCRYPT_PROFILES.find((candidate) => candidate.N === Number(N) && candidate.r === Number(r) && candidate.p === Number(p));
  if (!profile) return null;
  const salt = decode(saltValue, saltBytes);
  const hash = decode(hashValue, keyBytes);
  return salt && hash ? { profile, salt, hash } : null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(saltBytes);
  const key = await scrypt(input(password, current), salt, current);
  return `scrypt$${current.N}$${current.r}$${current.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export type VerifyResult =
  /** The password matches; `rehash` when the stored hash uses an older profile. */
  | { ok: true; rehash: boolean }
  /** Wrong password, or `malformed`: the stored hash failed the format check, so scrypt was not called. */
  | { ok: false; malformed: boolean };

export async function verifyPassword(password: string, stored: string): Promise<VerifyResult> {
  const parsed = parseHash(stored);
  if (!parsed) return { ok: false, malformed: true };
  const key = await scrypt(input(password, parsed.profile), parsed.salt, parsed.profile);
  return timingSafeEqual(key, parsed.hash) ? { ok: true, rehash: parsed.profile !== current } : { ok: false, malformed: false };
}

/**
 * A valid hash of a random password, verified when no account matches so a
 * failed sign-in takes the same time whether or not the account exists (AUTH-3).
 */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash() {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyHash;
}

/** Compares two secrets in constant time, whatever their lengths (AUTH-3). */
export function secretsEqual(left: string, right: string) {
  const digest = (value: string) => createHash('sha256').update(value, 'utf8').digest();
  return timingSafeEqual(digest(left), digest(right));
}
