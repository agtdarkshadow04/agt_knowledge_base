import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { getConfig } from './config.js';
import { getPool } from './db.js';
import { roles, type Role } from './domain.js';

const scrypt = promisify(scryptCallback);
const keyLength = 64;

export interface LocalSessionUser {
  sub: string;
  username: string;
  displayName: string;
  email?: string;
  role: Role;
  sessionVersion: number;
}

interface LocalUserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string;
  email: string | null;
  role: Role;
  session_version: number;
}

interface LocalTokenPayload extends LocalSessionUser {
  iat: number;
  exp: number;
}

function authSecret() {
  const secret = process.env.LOCAL_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('LOCAL_AUTH_SECRET must contain at least 32 characters.');
  }
  return secret;
}

function sessionHours() {
  return getConfig().session.ttlHours;
}

export function assertLocalAuthConfigured() {
  authSecret();
}

export async function hashPassword(password: string) {
  const salt = randomBytes(16);
  const derivedKey = await scrypt(password, salt, keyLength) as Buffer;
  return `scrypt$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
}

/**
 * A valid hash of a random password, verified when no account matches so a
 * failed sign-in takes the same time whether or not the account exists.
 */
let dummyHash: Promise<string> | undefined;
export function dummyPasswordHash() {
  dummyHash ??= hashPassword(randomBytes(32).toString('base64url'));
  return dummyHash;
}

export async function verifyPassword(password: string, encoded: string) {
  const [algorithm, saltValue, hashValue, ...extra] = encoded.split('$');
  if (algorithm !== 'scrypt' || !saltValue || !hashValue || extra.length) return false;
  try {
    const salt = Buffer.from(saltValue, 'base64url');
    const expected = Buffer.from(hashValue, 'base64url');
    if (salt.length !== 16 || expected.length !== keyLength) return false;
    const actual = await scrypt(password, salt, expected.length) as Buffer;
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export async function authenticateLocalUser(identifier: string, password: string): Promise<LocalSessionUser | null> {
  const normalized = identifier.trim().toLowerCase();
  if (!normalized || normalized.length > 254 || !password || password.length > 1024) return null;
  const pool = await getPool();
  const result = await pool.query<LocalUserRow>(
    `SELECT id, username, password_hash, display_name, email, role, session_version
     FROM local_users
     WHERE is_active = true AND (username = $1 OR email = $1)
     LIMIT 1`,
    [normalized],
  );
  const user = result.rows[0];
  if (!user) {
    await verifyPassword(password, await dummyPasswordHash());
    return null;
  }
  if (!await verifyPassword(password, user.password_hash)) return null;
  return {
    sub: user.id,
    username: user.username,
    displayName: user.display_name,
    email: user.email ?? undefined,
    role: user.role,
    sessionVersion: user.session_version,
  };
}

export function issueLocalToken(user: LocalSessionUser) {
  const now = Math.floor(Date.now() / 1000);
  const payload: LocalTokenPayload = {
    ...user,
    iat: now,
    exp: now + Math.floor(sessionHours() * 60 * 60),
  };
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signed = `${header}.${body}`;
  const signature = createHmac('sha256', authSecret()).update(signed).digest('base64url');
  return `${signed}.${signature}`;
}

export async function verifyLocalToken(token: string): Promise<LocalSessionUser> {
  if (token.length > 4096) throw new Error('Invalid session token.');
  const [header, body, signature, ...extra] = token.split('.');
  if (!header || !body || !signature || extra.length) throw new Error('Invalid session token.');
  const signed = `${header}.${body}`;
  const expected = createHmac('sha256', authSecret()).update(signed).digest();
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('Invalid session token.');
  }

  let payload: Partial<LocalTokenPayload>;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<LocalTokenPayload>;
  } catch {
    throw new Error('Invalid session token.');
  }
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== 'number' || payload.exp <= now
    || typeof payload.iat !== 'number' || payload.iat > now + 60
    || typeof payload.sub !== 'string' || !payload.sub
    || typeof payload.username !== 'string' || !payload.username
    || typeof payload.displayName !== 'string' || !payload.displayName
    || (payload.email !== undefined && typeof payload.email !== 'string')
    || !roles.includes(payload.role as Role)
    || !Number.isSafeInteger(payload.sessionVersion) || payload.sessionVersion! < 1) {
    throw new Error('Invalid session token.');
  }

  const pool = await getPool();
  const result = await pool.query<LocalUserRow>(
    `SELECT id, username, password_hash, display_name, email, role, session_version
     FROM local_users
     WHERE id = $1 AND is_active = true AND session_version = $2`,
    [payload.sub, payload.sessionVersion],
  );
  const current = result.rows[0];
  if (!current) throw new Error('Invalid session token.');
  return {
    sub: current.id,
    username: current.username,
    displayName: current.display_name,
    email: current.email ?? undefined,
    role: current.role,
    sessionVersion: current.session_version,
  };
}

