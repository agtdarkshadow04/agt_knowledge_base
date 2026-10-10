import type pg from 'pg';
import { getPool } from './db.js';
import {
  AppError,
  type Actor,
  type AdminStats,
  type ApplicationSettings,
  type LocalUserRecord,
  type Role,
} from './domain.js';
import { hashPassword, type LocalSessionUser } from './local-auth.js';

interface LocalUserRow {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: Role;
  is_active: boolean;
  is_super_admin: boolean;
  session_version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

interface SettingsRow {
  application_name: string;
  application_subtitle: string;
  default_visibility: ApplicationSettings['defaultVisibility'];
  allow_public_browsing: boolean;
  version: number;
}

const userColumns = `
  id, username, display_name, email, role, is_active, is_super_admin,
  session_version, created_at, updated_at
`;

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toUser(row: LocalUserRow): LocalUserRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email ?? undefined,
    role: row.role,
    isActive: row.is_active,
    isSuperAdmin: row.is_super_admin,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function toSessionUser(row: LocalUserRow): LocalSessionUser {
  return {
    sub: row.id,
    username: row.username,
    displayName: row.display_name,
    email: row.email ?? undefined,
    role: row.role,
    isSuperAdmin: row.is_super_admin,
    sessionVersion: row.session_version,
  };
}

function toSettings(row: SettingsRow): ApplicationSettings {
  return {
    applicationName: row.application_name,
    applicationSubtitle: row.application_subtitle,
    defaultVisibility: row.default_visibility,
    allowPublicBrowsing: row.allow_public_browsing,
    version: row.version,
  };
}

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function conflictFrom(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new AppError('That username or email address is already in use.', 409, 'USER_CONFLICT');
  }
  throw error;
}

async function lockedUser(client: pg.PoolClient, id: string) {
  const result = await client.query<LocalUserRow>(
    `SELECT ${userColumns} FROM local_users WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!result.rows[0]) throw new AppError('User not found.', 404, 'USER_NOT_FOUND');
  return result.rows[0];
}

async function assertActiveAdmin(client: pg.PoolClient, actor: Actor) {
  const result = await client.query(
    `SELECT 1
     FROM local_users
     WHERE id = $1 AND is_active = true AND role = 'Admin'
     FOR KEY SHARE`,
    [actor.sub],
  );
  if (!result.rowCount) throw new AppError('Administrator access is required.', 403, 'FORBIDDEN');
}

function assertMutable(target: LocalUserRow, actor: Actor, input?: { role: Role; isActive: boolean }) {
  if (target.is_super_admin) {
    if (input && (input.role !== 'Admin' || !input.isActive)) {
      throw new AppError('The super administrator cannot be demoted or deactivated.', 409, 'PROTECTED_USER');
    }
    if (actor.sub !== target.id) {
      throw new AppError('Only the super administrator can change their own account.', 409, 'PROTECTED_USER');
    }
  }
  if (target.id === actor.sub && input && !input.isActive) {
    throw new AppError('You cannot deactivate your own account.', 409, 'PROTECTED_USER');
  }
}

export class AdminService {
  async setupRequired() {
    const pool = await getPool();
    const result = await pool.query<{ required: boolean }>(
      'SELECT NOT EXISTS (SELECT 1 FROM local_users) AS required',
    );
    return result.rows[0]?.required ?? false;
  }

  async bootstrap(input: {
    username: string;
    displayName: string;
    email?: string;
    password: string;
  }): Promise<LocalSessionUser> {
    const passwordHash = await hashPassword(input.password);
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('LOCK TABLE local_users IN SHARE ROW EXCLUSIVE MODE');
      const existing = await client.query('SELECT 1 FROM local_users LIMIT 1');
      if (existing.rowCount) {
        throw new AppError('Setup has already been completed.', 409, 'SETUP_ALREADY_COMPLETED');
      }
      const result = await client.query<LocalUserRow>(
        `INSERT INTO local_users (
           username, password_hash, display_name, email, role, is_super_admin
         ) VALUES ($1, $2, $3, $4, 'Admin', true)
         RETURNING ${userColumns}`,
        [input.username, passwordHash, input.displayName, input.email ?? null],
      );
      await client.query('COMMIT');
      return toSessionUser(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      if (isUniqueViolation(error)) {
        throw new AppError('Setup has already been completed.', 409, 'SETUP_ALREADY_COMPLETED');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async listUsers(query: {
    search: string;
    role: 'all' | Role;
    active: 'all' | 'active' | 'inactive';
    page: number;
    pageSize: number;
  }) {
    const pool = await getPool();
    const conditions = [
      `($1 = '' OR username ILIKE '%' || $1 || '%' OR display_name ILIKE '%' || $1 || '%' OR email ILIKE '%' || $1 || '%')`,
      `($2 = 'all' OR role = $2)`,
      `($3 = 'all' OR ($3 = 'active' AND is_active) OR ($3 = 'inactive' AND NOT is_active))`,
    ];
    const params = [query.search, query.role, query.active];
    const offset = (query.page - 1) * query.pageSize;
    const [countResult, usersResult] = await Promise.all([
      pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM local_users WHERE ${conditions.join(' AND ')}`, params),
      pool.query<LocalUserRow>(
        `SELECT ${userColumns}
         FROM local_users
         WHERE ${conditions.join(' AND ')}
         ORDER BY is_super_admin DESC, lower(username), id
         LIMIT $4 OFFSET $5`,
        [...params, query.pageSize, offset],
      ),
    ]);
    const total = Number(countResult.rows[0]?.count ?? 0);
    return {
      items: usersResult.rows.map(toUser),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  async createUser(input: {
    username: string;
    displayName: string;
    email?: string;
    role: Role;
    password: string;
  }, actor: Actor) {
    const passwordHash = await hashPassword(input.password);
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertActiveAdmin(client, actor);
      const result = await client.query<LocalUserRow>(
        `INSERT INTO local_users (username, password_hash, display_name, email, role)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${userColumns}`,
        [input.username, passwordHash, input.displayName, input.email ?? null, input.role],
      );
      await client.query('COMMIT');
      return toUser(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      conflictFrom(error);
    } finally {
      client.release();
    }
  }

  async updateUser(id: string, input: {
    username: string;
    displayName: string;
    email?: string;
    role: Role;
    isActive: boolean;
  }, actor: Actor) {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertActiveAdmin(client, actor);
      const current = await lockedUser(client, id);
      assertMutable(current, actor, input);
      const securityChanged = current.role !== input.role || current.is_active !== input.isActive;
      const result = await client.query<LocalUserRow>(
        `UPDATE local_users
         SET username = $2,
             display_name = $3,
             email = $4,
             role = $5,
             is_active = $6,
             session_version = session_version + CASE WHEN $7 THEN 1 ELSE 0 END,
             updated_at = now()
         WHERE id = $1
         RETURNING ${userColumns}`,
        [id, input.username, input.displayName, input.email ?? null, input.role, input.isActive, securityChanged],
      );
      await client.query('COMMIT');
      return toUser(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      conflictFrom(error);
    } finally {
      client.release();
    }
  }

  async setPassword(id: string, password: string, actor: Actor) {
    const passwordHash = await hashPassword(password);
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertActiveAdmin(client, actor);
      const current = await lockedUser(client, id);
      assertMutable(current, actor);
      await client.query(
        `UPDATE local_users
         SET password_hash = $2, session_version = session_version + 1, updated_at = now()
         WHERE id = $1`,
        [id, passwordHash],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteUser(id: string, actor: Actor) {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertActiveAdmin(client, actor);
      const current = await lockedUser(client, id);
      if (current.id === actor.sub) {
        throw new AppError('You cannot delete your own account.', 409, 'PROTECTED_USER');
      }
      if (current.is_super_admin) {
        throw new AppError('The super administrator cannot be deleted.', 409, 'PROTECTED_USER');
      }
      await client.query('DELETE FROM local_users WHERE id = $1', [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getStats(): Promise<AdminStats> {
    const pool = await getPool();
    const result = await pool.query<Record<keyof AdminStats, string>>(`
      SELECT
        (SELECT count(*) FROM articles)::text AS "totalArticles",
        (SELECT count(*) FROM articles WHERE visibility = 'Public')::text AS "publicArticles",
        (SELECT count(*) FROM articles WHERE visibility = 'Internal')::text AS "internalArticles",
        (SELECT count(*) FROM articles WHERE visibility = 'Admin')::text AS "adminArticles",
        (SELECT count(*) FROM articles WHERE is_pinned)::text AS "pinnedArticles",
        (SELECT count(*) FROM articles WHERE is_protected)::text AS "protectedArticles",
        (SELECT count(*) FROM articles WHERE is_verified)::text AS "verifiedArticles",
        (SELECT count(*) FROM article_revisions)::text AS "articleRevisions",
        (SELECT count(*) FROM tags)::text AS "canonicalTags",
        (SELECT count(*)
         FROM articles a
         CROSS JOIN LATERAL unnest(a.tag_ids) stored(id)
         LEFT JOIN tags catalog ON catalog.id = stored.id
         WHERE catalog.id IS NULL)::text AS "orphanedTagReferences"
    `);
    const row = result.rows[0];
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])) as unknown as AdminStats;
  }

  async getSettings() {
    const pool = await getPool();
    const result = await pool.query<SettingsRow>(
      `SELECT application_name, application_subtitle, default_visibility, allow_public_browsing, version
       FROM application_settings WHERE singleton = true`,
    );
    if (!result.rows[0]) throw new Error('Application settings are missing.');
    return toSettings(result.rows[0]);
  }

  async updateSettings(input: ApplicationSettings) {
    const pool = await getPool();
    const result = await pool.query<SettingsRow>(
      `UPDATE application_settings
       SET application_name = $1,
           application_subtitle = $2,
           default_visibility = $3,
           allow_public_browsing = $4,
           version = version + 1,
           updated_at = now()
       WHERE singleton = true AND version = $5
       RETURNING application_name, application_subtitle, default_visibility, allow_public_browsing, version`,
      [
        input.applicationName,
        input.applicationSubtitle,
        input.defaultVisibility,
        input.allowPublicBrowsing,
        input.version,
      ],
    );
    if (!result.rows[0]) {
      throw new AppError('Application settings changed after you opened them. Reload and try again.', 409, 'VERSION_CONFLICT');
    }
    return toSettings(result.rows[0]);
  }
}
