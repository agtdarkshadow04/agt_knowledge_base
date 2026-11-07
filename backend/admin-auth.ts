import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import { getConfig } from './config.js';
import { getPool } from './db.js';
import { AppError } from './domain.js';
import { dummyPasswordHash, hashPassword, verifyPassword } from './local-auth.js';
import type { AdminIdentity } from './routes.js';

/**
 * The installation Admin: a single row in the `admin` table, entirely separate
 * from member accounts in `local_users`. Sessions are random 32-byte tokens
 * sent as an HttpOnly cookie; only their SHA-256 is stored, in `admin_sessions`.
 */

export const adminSessionCookie = 'agt_admin_session';
/** The cookie is sent only to the admin API, as the browser sees it behind Nginx. */
export const adminCookiePath = '/api/admin';
const setupPasswordVariable = 'AGT_SETUP_PASSWORD';

interface AdminRow {
  username: string;
  password_hash: string;
}

export interface AdminSessionResult {
  token: string;
  expiresAt: Date;
  admin: AdminIdentity;
}

function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Compares two strings in constant time with respect to their contents and lengths. */
export function constantTimeEqual(left: string, right: string) {
  return timingSafeEqual(sha256(left), sha256(right));
}

export function hashSessionToken(token: string) {
  return sha256(token).toString('hex');
}

/** The one-time setup password from the environment, or undefined when it is unset. */
export function setupPassword() {
  const value = process.env[setupPasswordVariable];
  return value ? value : undefined;
}

function sessionLifetimeMs() {
  return getConfig().adminSession.ttlHours * 60 * 60 * 1000;
}

async function createSession(client: pg.Pool | pg.PoolClient, username: string): Promise<AdminSessionResult> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + sessionLifetimeMs());
  await client.query('DELETE FROM admin_sessions WHERE expires_at <= now()');
  await client.query(
    'INSERT INTO admin_sessions (token_hash, expires_at) VALUES ($1, $2)',
    [hashSessionToken(token), expiresAt],
  );
  return { token, expiresAt, admin: { username } };
}

function invalidCredentials(): never {
  throw new AppError('Invalid username or password.', 401, 'INVALID_CREDENTIALS');
}

export class AdminAuthService {
  async setupStatus() {
    const pool = await getPool();
    const result = await pool.query('SELECT 1 FROM admin LIMIT 1');
    return { required: !result.rowCount, setupPasswordConfigured: setupPassword() !== undefined };
  }

  /**
   * Creates the Admin on a fresh installation. Requires AGT_SETUP_PASSWORD,
   * which is ignored once an Admin exists, and a new password that differs from it.
   */
  async setup(input: { setupPassword: string; username: string; password: string }): Promise<AdminSessionResult> {
    const expected = setupPassword();
    if (!expected) {
      throw new AppError(`Setup is disabled. Set ${setupPasswordVariable} on the server and restart it.`, 403, 'SETUP_DISABLED');
    }
    const pool = await getPool();
    const existing = await pool.query('SELECT 1 FROM admin LIMIT 1');
    if (existing.rowCount) throw new AppError('Setup has already been completed.', 409, 'SETUP_ALREADY_COMPLETED');
    if (!constantTimeEqual(input.setupPassword, expected)) {
      throw new AppError('The setup password is incorrect.', 401, 'INVALID_SETUP_PASSWORD');
    }
    if (constantTimeEqual(input.password, expected)) {
      throw new AppError('The new password must differ from the setup password.', 400, 'PASSWORD_REUSED');
    }
    const passwordHash = await hashPassword(input.password);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO admin (username, password_hash) VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [input.username, passwordHash],
      );
      if (!inserted.rowCount) throw new AppError('Setup has already been completed.', 409, 'SETUP_ALREADY_COMPLETED');
      const session = await createSession(client, input.username);
      await client.query('COMMIT');
      return session;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Verifies the Admin's credentials. When no Admin exists the password is
   * checked against a dummy hash, and usernames are compared in constant time,
   * so response timing does not reveal which part was wrong.
   */
  async login(username: string, password: string): Promise<AdminSessionResult> {
    const normalized = username.trim().toLowerCase();
    const pool = await getPool();
    const result = await pool.query<AdminRow>('SELECT username, password_hash FROM admin LIMIT 1');
    const admin = result.rows[0];
    const passwordValid = await verifyPassword(password, admin?.password_hash ?? await dummyPasswordHash());
    const usernameValid = constantTimeEqual(normalized, admin?.username ?? '');
    if (!admin || !passwordValid || !usernameValid) invalidCredentials();
    return createSession(pool, admin.username);
  }

  /** The Admin for a session token, or null when the token is unknown or expired. */
  async session(token: string): Promise<AdminIdentity | null> {
    if (!token || token.length > 200) return null;
    const pool = await getPool();
    const result = await pool.query<{ username: string }>(
      `SELECT admin.username
       FROM admin_sessions session
       CROSS JOIN admin
       WHERE session.token_hash = $1 AND session.expires_at > now()`,
      [hashSessionToken(token)],
    );
    return result.rows[0] ? { username: result.rows[0].username } : null;
  }

  async logout(token: string) {
    const pool = await getPool();
    await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [hashSessionToken(token)]);
  }

  /** Changes the Admin password, revokes every Admin session, and starts a new one. */
  async changePassword(currentPassword: string, password: string): Promise<AdminSessionResult> {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<AdminRow>('SELECT username, password_hash FROM admin FOR UPDATE');
      const admin = result.rows[0];
      if (!admin || !await verifyPassword(currentPassword, admin.password_hash)) {
        throw new AppError('The current password is incorrect.', 403, 'INVALID_CURRENT_PASSWORD');
      }
      const expected = setupPassword();
      if (expected && constantTimeEqual(password, expected)) {
        throw new AppError('The new password must differ from the setup password.', 400, 'PASSWORD_REUSED');
      }
      await client.query(
        'UPDATE admin SET password_hash = $1, updated_at = now()',
        [await hashPassword(password)],
      );
      await client.query('DELETE FROM admin_sessions');
      const session = await createSession(client, admin.username);
      await client.query('COMMIT');
      return session;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

/** Reads one cookie from a Cookie header. */
export function readCookie(header: string | undefined, name: string) {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return undefined;
}

export function sessionCookie(token: string, expiresAt: Date, secure: boolean) {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [
    `${adminSessionCookie}=${token}`,
    `Path=${adminCookiePath}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

export function clearedSessionCookie(secure: boolean) {
  return [
    `${adminSessionCookie}=`,
    `Path=${adminCookiePath}`,
    'Max-Age=0',
    'HttpOnly',
    'SameSite=Strict',
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}
