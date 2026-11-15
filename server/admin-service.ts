import type pg from 'pg';
import type { AppContext } from './context.js';
import { HttpError } from './http.js';
import { type AdminStats, type LocalUserRecord, type Role } from './domain.js';
import { hashPassword } from './passwords.js';

interface LocalUserRow {
  id: string;
  username: string;
  display_name: string;
  email: string | null;
  role: Role;
  is_active: boolean;
  session_version: number;
  created_at: Date | string;
  updated_at: Date | string;
}

const userColumns = `
  id, username, display_name, email, role, is_active,
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
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function isUniqueViolation(error: unknown) {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}

function conflictFrom(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new HttpError(409, 'conflict', 'That username or email address is already in use.', { legacyCode: 'USER_CONFLICT' });
  }
  throw error;
}

async function lockedUser(client: pg.PoolClient, id: string) {
  const result = await client.query<LocalUserRow>(
    `SELECT ${userColumns} FROM local_users WHERE id = $1 FOR UPDATE`,
    [id],
  );
  if (!result.rows[0]) throw new HttpError(404, 'not_found', 'User not found.', { legacyCode: 'USER_NOT_FOUND' });
  return result.rows[0];
}

export class AdminService {
  constructor(private readonly context: Pick<AppContext, 'db'>) {}

  async listUsers(query: {
    search: string;
    role: 'all' | Role;
    active: 'all' | 'active' | 'inactive';
    page: number;
    pageSize: number;
  }) {
    const pool = await this.context.db.pool();
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
         ORDER BY lower(username), id
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
  }) {
    const passwordHash = await hashPassword(input.password);
    const pool = await this.context.db.pool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
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
  }) {
    const pool = await this.context.db.pool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const current = await lockedUser(client, id);
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
      // A role change or deactivation ends every session of that member (AUTH-4, AUTH-1 deviation).
      if (securityChanged) await client.query('DELETE FROM member_sessions WHERE user_id = $1', [id]);
      await client.query('COMMIT');
      return toUser(result.rows[0]);
    } catch (error) {
      await client.query('ROLLBACK');
      conflictFrom(error);
    } finally {
      client.release();
    }
  }

  async setPassword(id: string, password: string) {
    const passwordHash = await hashPassword(password);
    const pool = await this.context.db.pool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockedUser(client, id);
      await client.query(
        `UPDATE local_users
         SET password_hash = $2, session_version = session_version + 1, updated_at = now()
         WHERE id = $1`,
        [id, passwordHash],
      );
      await client.query('DELETE FROM member_sessions WHERE user_id = $1', [id]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteUser(id: string) {
    const pool = await this.context.db.pool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await lockedUser(client, id);
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
    const pool = await this.context.db.pool();
    const result = await pool.query<Record<keyof AdminStats, string>>(`
      SELECT
        (SELECT count(*) FROM articles)::text AS "totalArticles",
        (SELECT count(*) FROM articles WHERE visibility IN ('"Public"'::jsonb, '0'::jsonb))::text AS "publicArticles",
        (SELECT count(*) FROM articles WHERE visibility IN ('"Internal"'::jsonb, '1'::jsonb))::text AS "internalArticles",
        (SELECT count(*) FROM articles WHERE visibility IN ('"Admin"'::jsonb, '2'::jsonb, '3'::jsonb, '4'::jsonb, '5'::jsonb))::text AS "adminArticles",
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

}
