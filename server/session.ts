import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AppContext } from './context.js';
import { withTransaction } from './db.js';
import * as repo from './repository/sessions.js';
import { isSecurityLevel, roles, type Role, type SecurityLevel } from './domain.js';
import { fieldError } from '../src/lib/errors.js';
import { HttpError } from './http.js';
import { dummyPasswordHash, hashPassword, secretsEqual, verifyPassword } from './passwords.js';
import type { AdminIdentity } from './routes.js';
import { iamStatus, iamUnavailable, invalidIamCredentials, type IamTraveller, type IamVerifier } from './iam.js';
import { SettingsService } from './settings-service.js';

/**
 * Sign-in, setup and cookie sessions (AUTH-3..AUTH-8). The installation Admin
 * signs in with the `agt_knowledge_base_session` cookie, stored in `sessions`;
 * members (AUTH-1 deviation) with `agt_knowledge_base_member_session`, stored in
 * `member_sessions`. Tokens are 32 random bytes, base64url; only their SHA-256
 * is stored. Neither cookie is ever accepted in place of the other.
 */

export const adminSessionCookie = 'agt_knowledge_base_session';
export const memberSessionCookie = 'agt_knowledge_base_member_session';
/** The 1.x Admin cookie, cleared on sign-in and sign-out so browsers drop it. */
export const legacyAdminSessionCookie = { name: 'agt_admin_session', path: '/api/admin' };
export const setupPasswordVariable = 'AGT_KNOWLEDGE_BASE_SETUP_PASSWORD';

/** Writes to the server log; services get it from the app so tests can watch it. */
export interface AuthLog {
  error(message: string): void;
  info(message: string): void;
}

const silentLog: AuthLog = { error: () => undefined, info: () => undefined };

export interface SessionResult<Identity> {
  token: string;
  expiresAt: Date;
  identity: Identity;
}

export type AdminSessionResult = SessionResult<AdminIdentity>;

/** A signed-in member, as the session lookup returns it. */
export interface MemberUser {
  sub: string;
  /** The local username, or the Traveller Name of a member who signs in through AGT IAM. */
  username: string;
  displayName: string;
  email?: string;
  role: Role;
  /** The articles the member reads and may assign (#70). */
  securityLevel: SecurityLevel;
  /** How the member signs in: a local password or their AGT account. */
  authSource: 'local' | 'agt_iam';
}

export function hashSessionToken(token: string) {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** A new session: 32 random bytes, base64url, stored only as its SHA-256 (AUTH-8). */
async function createSession(sql: repo.Sql, ttlHours: number, memberId?: string, maxSeconds?: number) {
  const token = randomBytes(32).toString('base64url');
  const ttlMilliseconds = Math.min(ttlHours * 60 * 60 * 1000, maxSeconds === undefined ? Infinity : maxSeconds * 1000);
  const expiresAt = new Date(Date.now() + ttlMilliseconds);
  await repo.insertSession(sql, hashSessionToken(token), expiresAt, memberId);
  return { token, expiresAt };
}

function passwordReused() {
  const message = 'The new password must differ from the setup password.';
  return new HttpError(400, 'validation_failed', message, {
    fields: [fieldError('password', 'same_as_setup_password', message)],
    legacyCode: 'PASSWORD_REUSED',
  });
}

function invalidCredentials(legacyCode?: string): never {
  throw new HttpError(401, 'invalid_credentials', 'Invalid username or password.', legacyCode ? { legacyCode } : {});
}

/** A token as long as no real one can be is never looked up. */
function plausibleToken(token: string | undefined): token is string {
  return typeof token === 'string' && token.length > 0 && token.length <= 200;
}

/** Password hashing, replaceable in tests. */
export interface PasswordHasher {
  hashPassword: typeof hashPassword;
  verifyPassword: typeof verifyPassword;
  dummyPasswordHash: typeof dummyPasswordHash;
}

const scryptHasher: PasswordHasher = { hashPassword, verifyPassword, dummyPasswordHash };

/** The single Admin: setup (AUTH-5, AUTH-6), sign-in (AUTH-3), sessions (AUTH-8) and the password change (AUTH-4). */
export class AdminAuthService {
  constructor(
    private readonly context: Pick<AppContext, 'config' | 'db' | 'setupPassword'>,
    private readonly passwords: PasswordHasher = scryptHasher,
    private readonly log: AuthLog = silentLog,
  ) {}

  private ttlHours() {
    return this.context.config.adminSession.ttlHours ?? this.context.config.session.ttlHours;
  }

  private async newSession(sql: repo.Sql, username: string): Promise<AdminSessionResult> {
    return { ...await createSession(sql, this.ttlHours()), identity: { username } };
  }

  /** Verifies the Admin password; a malformed stored hash never verifies and is logged (AUTH-2). */
  private async passwordMatches(password: string, stored: string) {
    const result = await this.passwords.verifyPassword(password, stored);
    if (!result.ok && result.malformed) this.log.error('The stored admin password hash is malformed or uses unsupported scrypt parameters.');
    return result;
  }

  async adminExists() {
    return repo.adminExists(await this.context.db.pool());
  }

  /** `GET /api/setup/status`: `required` is the deprecated 1.x name of `!adminExists`. */
  async setupStatus() {
    const adminExists = await this.adminExists();
    return { adminExists, setupPasswordConfigured: this.context.setupPassword !== null, required: !adminExists };
  }

  /**
   * Creates the Admin on a fresh installation (AUTH-5). Requires
   * AGT_KNOWLEDGE_BASE_SETUP_PASSWORD, which never becomes the Admin password
   * and is ignored once an Admin exists.
   */
  async setup(input: { setupPassword: string; username: string; password: string }): Promise<AdminSessionResult> {
    const pool = await this.context.db.pool();
    if (await this.adminExists()) throw this.setupComplete();
    const expected = this.context.setupPassword;
    if (expected === null) {
      throw new HttpError(503, 'setup_password_missing', `Setup is unavailable: ${setupPasswordVariable} is not set. Set it in .env and restart.`, {
        legacyCode: 'SETUP_DISABLED',
      });
    }
    if (!secretsEqual(input.setupPassword, expected)) {
      throw new HttpError(401, 'invalid_setup_password', 'The setup password is incorrect.');
    }
    if (secretsEqual(input.password, expected)) throw passwordReused();
    const passwordHash = await this.passwords.hashPassword(input.password);
    const session = await withTransaction(pool, async (client) => {
      if (!await repo.insertAdmin(client, input.username, passwordHash)) throw this.setupComplete();
      return this.newSession(client, input.username);
    });
    this.log.info(`Admin account created. Remove ${setupPasswordVariable} from .env and restart.`);
    return session;
  }

  private setupComplete() {
    return new HttpError(410, 'setup_complete', 'Setup has already been completed.', { legacyCode: 'SETUP_ALREADY_COMPLETED' });
  }

  /**
   * Verifies the Admin's credentials (AUTH-3). The username is trimmed and
   * compared exactly, in constant time; without an Admin the password is checked
   * against a dummy hash, so timing reveals neither which part was wrong nor
   * whether setup has run.
   */
  async login(username: string, password: string): Promise<AdminSessionResult> {
    const pool = await this.context.db.pool();
    const admin = await repo.adminAccount(pool);
    const result = admin
      ? await this.passwordMatches(password, admin.password_hash)
      : await this.passwords.verifyPassword(password, await this.passwords.dummyPasswordHash());
    const usernameValid = secretsEqual(username.trim(), admin?.username ?? '');
    if (!admin || !result.ok || !usernameValid) invalidCredentials();
    if (result.rehash) {
      await repo.updateAdminPassword(pool, await this.passwords.hashPassword(password));
    }
    return this.newSession(pool, admin.username);
  }

  /** The Admin for a session token, or null when the token is unknown or expired. */
  async session(token: string | undefined): Promise<AdminIdentity | null> {
    if (!plausibleToken(token)) return null;
    const admin = await repo.adminForSession(await this.context.db.pool(), hashSessionToken(token));
    return admin ? { username: admin.username } : null;
  }

  async logout(token: string | undefined) {
    if (!plausibleToken(token)) return;
    await repo.deleteAdminSession(await this.context.db.pool(), hashSessionToken(token));
  }

  /** Changes the Admin password, ends every session and starts a new one for the caller (AUTH-4). */
  async changePassword(currentPassword: string, password: string): Promise<AdminSessionResult> {
    return withTransaction(await this.context.db.pool(), async (client) => {
      const admin = await repo.adminAccount(client, true);
      if (!admin || !(await this.passwordMatches(currentPassword, admin.password_hash)).ok) {
        invalidCredentials('INVALID_CURRENT_PASSWORD');
      }
      const expected = this.context.setupPassword;
      if (expected !== null && secretsEqual(password, expected)) throw passwordReused();
      await repo.updateAdminPassword(client, await this.passwords.hashPassword(password));
      await repo.deleteAllAdminSessions(client);
      return this.newSession(client, admin.username);
    });
  }
}

function toMember(row: Omit<repo.MemberRow, 'password_hash'>): MemberUser {
  return {
    sub: row.id,
    username: row.username ?? row.iam_traveller_name ?? '',
    displayName: row.display_name,
    email: row.email ?? undefined,
    role: roles.includes(row.role) ? row.role : 'Editor',
    // A stored level outside 0-5 cannot exist (CHECK); 0 is the safe reading anyway.
    securityLevel: isSecurityLevel(row.security_level) ? row.security_level : 0,
    authSource: row.auth_source,
  };
}

/** Member sign-in and cookie sessions (AUTH-1 deviation: the AUTH-2/3/8 rules applied to members). */
export class MemberAuthService {
  private readonly settings: SettingsService;

  constructor(
    private readonly context: Pick<AppContext, 'config' | 'db' | 'iamApiKey'>,
    private readonly passwords: PasswordHasher = scryptHasher,
    private readonly log: AuthLog = silentLog,
    /** AGT IAM; `IamClient` in the app, a fake in tests. Without it AGT sign-in is unavailable. */
    private readonly iam?: IamVerifier,
  ) {
    this.settings = new SettingsService(context);
  }

  private async iamAvailability() {
    return iamStatus(this.context, await this.settings.values());
  }

  /** Signs a member in by username or email; inactive members cannot (`401 invalid_credentials`). */
  async login(identifier: string, password: string): Promise<SessionResult<MemberUser>> {
    const normalized = identifier.trim().toLowerCase();
    const pool = await this.context.db.pool();
    const user = normalized && normalized.length <= 254 ? await repo.activeMemberByLogin(pool, normalized) : undefined;
    if (!user) {
      await this.passwords.verifyPassword(password, await this.passwords.dummyPasswordHash());
      invalidCredentials();
    }
    const result = await this.passwords.verifyPassword(password, user.password_hash);
    if (!result.ok) {
      if (result.malformed) this.log.error('A stored member password hash is malformed or uses unsupported scrypt parameters.');
      invalidCredentials();
    }
    if (result.rehash) {
      await repo.updateMemberPassword(pool, user.id, await this.passwords.hashPassword(password));
    }
    const session = await createSession(pool, this.context.config.session.ttlHours, user.id);
    return { ...session, identity: toMember(user) };
  }

  /**
   * Step 1 of an AGT sign-in, outside any data write so a slow IAM never holds
   * the write lock (BAK-8): checks that AGT sign-in is on and configured, then
   * asks IAM. The password goes only to IAM and is never stored.
   */
  async verifyIam(travellerName: string, password: string): Promise<IamTraveller> {
    const status = await this.iamAvailability();
    if (!status.enabled) throw new HttpError(403, 'iam_disabled', 'AGT sign-in is turned off.');
    if (!status.available || !this.iam) throw iamUnavailable();
    const traveller = await this.iam.verify(travellerName, password);
    return { ...traveller, travellerName: traveller.travellerName || travellerName };
  }

  /**
   * Step 2, inside the data write: creates the member on a traveller's first
   * AGT sign-in, or refreshes its name, permission and role (a role change ends
   * its other sessions, AUTH-4), then starts a session that ends no later than
   * IAM's own token. A member the Admin deactivated cannot sign in.
   */
  async completeIamLogin(traveller: IamTraveller): Promise<SessionResult<MemberUser>> {
    if (!(await this.iamAvailability()).available) throw new HttpError(403, 'iam_disabled', 'AGT sign-in is turned off.');
    return withTransaction(await this.context.db.pool(), async (client) => {
      const input = {
        travellerId: traveller.travellerId,
        travellerName: traveller.travellerName,
        permission: traveller.permission,
        role: traveller.role,
        securityLevel: traveller.securityLevel,
      };
      const existing = await repo.iamMemberForUpdate(client, traveller.travellerId);
      if (existing && !existing.is_active) invalidIamCredentials();
      let member: Omit<repo.MemberRow, 'password_hash'>;
      if (existing) {
        member = await repo.updateIamMember(client, existing.id, input);
        // IAM's role and security level win; a change of either ends the member's other sessions (AUTH-4, #70).
        if (existing.role !== member.role || existing.security_level !== member.security_level) await repo.deleteMemberSessions(client, existing.id);
      } else {
        member = await repo.insertIamMember(client, randomUUID(), input);
      }
      const session = await createSession(client, this.context.config.session.ttlHours, member.id, traveller.expiresInSeconds);
      return { ...session, identity: toMember(member) };
    });
  }

  /** The active member for a session token, or null; an AGT member's session counts only while AGT sign-in is available. */
  async session(token: string | undefined): Promise<MemberUser | null> {
    if (!plausibleToken(token)) return null;
    const member = await repo.memberForSession(await this.context.db.pool(), hashSessionToken(token));
    if (!member) return null;
    if (member.auth_source === 'agt_iam' && !(await this.iamAvailability()).available) return null;
    return toMember(member);
  }

  async logout(token: string | undefined) {
    if (!plausibleToken(token)) return;
    await repo.deleteMemberSession(await this.context.db.pool(), hashSessionToken(token));
  }
}

/** A session cookie with the AUTH-8 attributes. */
export function sessionCookie(name: string, token: string, expiresAt: Date, secure: boolean) {
  const maxAge = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [`${name}=${token}`, 'Path=/', `Max-Age=${maxAge}`, 'HttpOnly', 'SameSite=Strict', ...(secure ? ['Secure'] : [])].join('; ');
}

export function clearedCookie(name: string, secure: boolean, path = '/') {
  return [`${name}=`, `Path=${path}`, 'Max-Age=0', 'HttpOnly', 'SameSite=Strict', ...(secure ? ['Secure'] : [])].join('; ');
}
