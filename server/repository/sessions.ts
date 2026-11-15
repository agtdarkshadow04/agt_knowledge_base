import type { Role } from '../domain.js';

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
  username: string;
  password_hash: string;
  display_name: string;
  email: string | null;
  role: Role;
}

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
  const inserted = await sql.query('INSERT INTO admin (username, password_hash) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING', [username, passwordHash]);
  return Boolean(inserted.rowCount);
}

export async function updateAdminPassword(sql: Sql, passwordHash: string) {
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

export async function deleteAdminSession(sql: Sql, tokenHash: string) {
  await sql.query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

/** An active member by username or email (already normalized). */
export async function activeMemberByLogin(sql: Sql, identifier: string): Promise<MemberRow | undefined> {
  return (await sql.query<MemberRow>(
    `SELECT id, username, password_hash, display_name, email, role
     FROM local_users
     WHERE is_active = true AND (username = $1 OR email = $1)
     LIMIT 1`,
    [identifier],
  )).rows[0];
}

export async function updateMemberPassword(sql: Sql, memberId: string, passwordHash: string) {
  await sql.query('UPDATE local_users SET password_hash = $2, updated_at = now() WHERE id = $1', [memberId, passwordHash]);
}

/** The active member an unexpired session belongs to. */
export async function memberForSession(sql: Sql, tokenHash: string): Promise<Omit<MemberRow, 'password_hash'> | undefined> {
  return (await sql.query<Omit<MemberRow, 'password_hash'>>(
    `SELECT member.id, member.username, member.display_name, member.email, member.role
     FROM member_sessions session
     JOIN local_users member ON member.id = session.user_id
     WHERE session.token_hash = $1 AND session.expires_at > now() AND member.is_active`,
    [tokenHash],
  )).rows[0];
}

export async function deleteMemberSession(sql: Sql, tokenHash: string) {
  await sql.query('DELETE FROM member_sessions WHERE token_hash = $1', [tokenHash]);
}
