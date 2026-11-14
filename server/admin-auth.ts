import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type pg from 'pg';
import type { AppContext } from './context.js';
import { fieldError } from '../src/lib/errors.js';
import { HttpError } from './http.js';
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

async function createSession(client: pg.Pool | pg.PoolClient, username: string, ttlHours: number): Promise<AdminSessionResult> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  await client.query('DELETE FROM admin_sessions WHERE expires_at <= now()');
  await client.query(
    'INSERT INTO admin_sessions (token_hash, expires_at) VALUES ($1, $2)',
    [hashSessionToken(token), expiresAt],
  );
  return { token, expiresAt, admin: { username } };
}

function passwordReused() {
  const message = 'The new password must differ from the setup password.';
  return new HttpError(400, 'validation_failed', message, {
    fields: [fieldError('password', 'same_as_setup_password', message)],
    legacyCode: 'PASSWORD_REUSED',
  });
}

function invalidCredentials(): never {
  throw new HttpError(401, 'invalid_credentials', 'Invalid username or password.');
}

/** Password hashing, replaceable in tests. */
export interface PasswordHasher {
  hashPassword: typeof hashPassword;
  verifyPassword: typeof verifyPassword;
  dummyPasswordHash: typeof dummyPasswordHash;
}

const scryptHasher: PasswordHasher = { hashPassword, verifyPassword, dummyPasswordHash };

export class AdminAuthService {
  constructor(
    private readonly context: Pick<AppContext, 'config' | 'db' | 'setupPassword'>,
    private readonly passwords: PasswordHasher = scryptHasher,
  ) {}

  /** The one-time setup password from the environment, or undefined when it is unset. */
  private setupPassword() {
    return this.context.setupPassword ?? undefined;
  }

  private createSession(client: pg.Pool | pg.PoolClient, username: string) {
    return createSession(client, username, this.context.config.adminSession.ttlHours);
  }

  async setupStatus() {
    const pool = await this.context.db.pool();
    const result = await pool.query('SELECT 1 FROM admin LIMIT 1');
    return { required: !result.rowCount, setupPasswordConfigured: this.setupPassword() !== undefined };
  }

  /**
   * Creates the Admin on a fresh installation. Requires AGT_SETUP_PASSWORD,
   * which is ignored once an Admin exists, and a new password that differs from it.
   */
  async setup(input: { setupPassword: string; username: string; password: string }): Promise<AdminSessionResult> {
    const expected = this.setupPassword();
    if (!expected) {
      throw new HttpError(403, 'setup_disabled', `Setup is disabled. Set ${setupPasswordVariable} on the server and restart it.`);
    }
    const pool = await this.context.db.pool();
    const existing = await pool.query('SELECT 1 FROM admin LIMIT 1');
    if (existing.rowCount) throw new HttpError(409, 'setup_already_completed', 'Setup has already been completed.');
    if (!constantTimeEqual(input.setupPassword, expected)) {
      throw new HttpError(401, 'invalid_setup_password', 'The setup password is incorrect.');
    }
    if (constantTimeEqual(input.password, expected)) {
      throw passwordReused();
    }
    const passwordHash = await this.passwords.hashPassword(input.password);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO admin (username, password_hash) VALUES ($1, $2)
         ON CONFLICT (id) DO NOTHING`,
        [input.username, passwordHash],
      );
      if (!inserted.rowCount) throw new HttpError(409, 'setup_already_completed', 'Setup has already been completed.');
      const session = await this.createSession(client, input.username);
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
    const pool = await this.context.db.pool();
    const result = await pool.query<AdminRow>('SELECT username, password_hash FROM admin LIMIT 1');
    const admin = result.rows[0];
    const passwordValid = await this.passwords.verifyPassword(password, admin?.password_hash ?? await this.passwords.dummyPasswordHash());
    const usernameValid = constantTimeEqual(normalized, admin?.username ?? '');
    if (!admin || !passwordValid || !usernameValid) invalidCredentials();
    return this.createSession(pool, admin.username);
  }

  /** The Admin for a session token, or null when the token is unknown or expired. */
  async session(token: string): Promise<AdminIdentity | null> {
    if (!token || token.length > 200) return null;
    const pool = await this.context.db.pool();
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
    const pool = await this.context.db.pool();
    await pool.query('DELETE FROM admin_sessions WHERE token_hash = $1', [hashSessionToken(token)]);
  }

  /** Changes the Admin password, revokes every Admin session, and starts a new one. */
  async changePassword(currentPassword: string, password: string): Promise<AdminSessionResult> {
    const pool = await this.context.db.pool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<AdminRow>('SELECT username, password_hash FROM admin FOR UPDATE');
      const admin = result.rows[0];
      if (!admin || !await this.passwords.verifyPassword(currentPassword, admin.password_hash)) {
        throw new HttpError(403, 'invalid_current_password', 'The current password is incorrect.');
      }
      const expected = this.setupPassword();
      if (expected && constantTimeEqual(password, expected)) {
        throw passwordReused();
      }
      await client.query(
        'UPDATE admin SET password_hash = $1, updated_at = now()',
        [await this.passwords.hashPassword(password)],
      );
      await client.query('DELETE FROM admin_sessions');
      const session = await this.createSession(client, admin.username);
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
