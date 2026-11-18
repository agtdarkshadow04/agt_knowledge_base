import type { Role } from '../domain.js';
import { assertDataWrite } from '../dataWrite.js';

/**
 * The SQL of the Admin account, member sign-in and both session tables
 * (SRV-4); `server/session.ts` holds the rules. Session tokens never reach
 * this file, only their SHA-256 hashes.
 */

/** A pool or a client inside a transaction. */
export interface Sql {
  query<Row = unknown>(sql: string, values?: unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

export interface AdminRow {
  username: string;
  password_hash: string;
}

export interface MemberRow {
  id: string;
  /** Null for a member who signs in through AGT IAM. */
  username: string | null;
  /** Null for a member who signs in through AGT IAM. */
  password_hash: string | null;
  display_name: string;
  email: string | null;
  role: Role;
  auth_source: 'local' | 'agt_iam';
  iam_traveller_name: string | null;
}

/** A local member, who signs in with a username or email and a password. */
export type LocalMemberRow = MemberRow & { username: string; password_hash: string; auth_source: 'local' };

const memberColumns = 'member.id, member.username, member.display_name, member.email, member.role, member.auth_source, member.iam_traveller_name';

/** Adds a session row; expired rows of the table are purged first (AUTH-8). */
export async function insertSession(sql: Sql, tokenHash: string, expiresAt: Date, memberId?: string) {
  if (memberId === undefined) {
    await sql.query('DELETE FROM sessions WHERE expires_at <= now()');
    await sql.query('INSERT INTO sessions (token_hash, expires_at) VALUES ($1, $2)', [tokenHash, expiresAt]);
  } else {
    await sql.query('DELETE FROM member_sessions WHERE expires_at <= now()');
    await sql.query('INSERT INTO member_sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash, memberId, expiresAt]);
  }
}

export async function adminExists(sql: Sql) {
  return Boolean((await sql.query('SELECT 1 FROM admin LIMIT 1')).rowCount);
}

/** The Admin's credentials; `lock` holds the row for a password change. */
export async function adminAccount(sql: Sql, lock = false): Promise<AdminRow | undefined> {
  return (await sql.query<AdminRow>(lock ? 'SELECT username, password_hash FROM admin FOR UPDATE' : 'SELECT username, password_hash FROM admin LIMIT 1')).rows[0];
}

/** Creates the Admin; false when one already exists. */
export async function insertAdmin(sql: Sql, username: string, passwordHash: string) {
  assertDataWrite();
  const inserted = await sql.query('INSERT INTO admin (username, password_hash) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [username, passwordHash]);
  return Boolean(inserted.rowCount);
}

export async function updateAdminPassword(sql: Sql, passwordHash: string) {
  assertDataWrite();
  await sql.query('UPDATE admin SET password_hash = $1, updated_at = now()', [passwordHash]);
}

export async function deleteAllAdminSessions(sql: Sql) {
  await sql.query('DELETE FROM sessions');
}

export async function adminForSession(sql: Sql, tokenHash: string) {
  const result = await sql.query<{ username: string }>(
    `SELECT admin.username
     FROM sessions session
     CROSS JOIN admin
     WHERE session.token_hash = $1 AND session.expires_at > now()`,
    [tokenHash],
  );
  return result.rows[0];
}

/** When an unexpired Admin session ends, for the BAK-11 recovery session. */
export async function adminSessionExpiry(sql: Sql, tokenHash: string): Promise<Date | undefined> {
  return (await sql.query<{ expires_at: Date }>('SELECT expires_at FROM sessions WHERE token_hash = $1 AND expires_at > now()', [tokenHash])).rows[0]?.expires_at;
}

export async function deleteAdminSession(sql: Sql, tokenHash: string) {
  await sql.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

/** An active local member by username or email (already normalized); AGT IAM members never match. */
export async function activeMemberByLogin(sql: Sql, identifier: string): Promise<LocalMemberRow | undefined> {
  return (await sql.query<LocalMemberRow>(
    `SELECT ${memberColumns}, member.password_hash
     FROM local_users member
     WHERE member.is_active = true AND member.auth_source = 'local' AND (member.username = $1 OR member.email = $1)
     LIMIT 1`,
    [identifier],
  )).rows[0];
}

/** The AGT IAM member with this traveller ID, locked for the sign-in that updates it. */
export async function iamMemberForUpdate(sql: Sql, travellerId: string) {
  return (await sql.query<Omit<MemberRow, 'password_hash'> & { is_active: boolean }>(
    `SELECT ${memberColumns}, member.is_active
     FROM local_users member
     WHERE member.auth_source = 'agt_iam' AND member.iam_traveller_id = $1
     FOR UPDATE`,
    [travellerId],
  )).rows[0];
}

export interface IamMemberWrite {
  travellerId: string;
  travellerName: string;
  permission: string;
  role: Role;
}

/** Creates the member for a traveller's first AGT sign-in, without a username or password. */
export async function insertIamMember(sql: Sql, id: string, input: IamMemberWrite) {
  assertDataWrite();
  return (await sql.query<Omit<MemberRow, 'password_hash'>>(
    `INSERT INTO local_users AS member (id, username, password_hash, display_name, email, role, auth_source,
       iam_traveller_id, iam_traveller_name, iam_permission, iam_synced_at)
     VALUES ($1, NULL, NULL, $2, NULL, $3, 'agt_iam', $4, $2, $5, now())
     RETURNING ${memberColumns}`,
    [id, input.travellerName, input.role, input.travellerId, input.permission],
  )).rows[0];
}

/** Refreshes an AGT IAM member's name, permission and role from a sign-in. */
export async function updateIamMember(sql: Sql, id: string, input: IamMemberWrite) {
  assertDataWrite();
  return (await sql.query<Omit<MemberRow, 'password_hash'>>(
    `UPDATE local_users AS member
     SET display_name = $2, iam_traveller_name = $2, role = $3, iam_permission = $4, iam_synced_at = now(), updated_at = now()
     WHERE member.id = $1
     RETURNING ${memberColumns}`,
    [id, input.travellerName, input.role, input.permission],
  )).rows[0];
}

/** Ends every session of one member (AUTH-4). */
export async function deleteMemberSessions(sql: Sql, memberId: string) {
  await sql.query('DELETE FROM member_sessions WHERE user_id = $1', [memberId]);
}

/** Ends every session of every AGT IAM member: AGT sign-in was switched off. */
export async function deleteIamMemberSessions(sql: Sql) {
  await sql.query(`DELETE FROM member_sessions WHERE user_id IN (SELECT id FROM local_users WHERE auth_source = 'agt_iam')`);
}

export async function updateMemberPassword(sql: Sql, memberId: string, passwordHash: string) {
  assertDataWrite();
  await sql.query('UPDATE local_users SET password_hash = $2, updated_at = now() WHERE id = $1', [memberId, passwordHash]);
}

/** The active member an unexpired session belongs to. */
export async function memberForSession(sql: Sql, tokenHash: string): Promise<Omit<MemberRow, 'password_hash'> | undefined> {
  return (await sql.query<Omit<MemberRow, 'password_hash'>>(
    `SELECT ${memberColumns}
     FROM member_sessions session
     JOIN local_users member ON member.id = session.user_id
     WHERE session.token_hash = $1 AND session.expires_at > now() AND member.is_active`,
    [tokenHash],
  )).rows[0];
}

export async function deleteMemberSession(sql: Sql, tokenHash: string) {
  await sql.query('DELETE FROM member_sessions WHERE token_hash = $1', [tokenHash]);
}
