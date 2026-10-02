import type pg from 'pg';
import type {
  Actor,
  ArticleListResult,
  ArticleRecord,
  ArticleRevisionRecord,
  ArticleVisibility,
  ArticleWrite,
  ListArticlesQuery,
  Role,
} from './domain.js';
import { getPool } from './db.js';
import type { ArticleRepository } from './repository.js';

interface ArticleRow {
  id: string;
  title: string;
  content?: string;
  content_preview?: string;
  tags: string[];
  visibility: ArticleVisibility;
  is_pinned: boolean;
  is_protected: boolean;
  is_verified: boolean;
  created_at: Date | string;
  created_by: string;
  created_by_name: string;
  modified_at: Date | string;
  modified_by: string;
  modified_by_name: string;
  version: number;
}

interface ArticleRevisionRow {
  article_id: string;
  title: string;
  content: string;
  tags: string[];
  visibility: ArticleVisibility;
  is_pinned: boolean;
  is_protected: boolean;
  is_verified: boolean;
  revised_at: Date | string;
  revised_by: string;
  revised_by_name: string;
  version: number;
}

const baseSelect = `
  a.id, a.title, a.content, a.tags, a.visibility, a.is_pinned, a.is_protected, a.is_verified,
  a.created_at, a.created_by, creator.display_name AS created_by_name,
  a.modified_at, a.modified_by, editor.display_name AS modified_by_name,
  a.version
`;

const revisionSelect = `
  r.article_id, r.title, r.content, r.tags, r.visibility, r.is_pinned, r.is_protected, r.is_verified,
  r.revised_at, r.revised_by, editor.display_name AS revised_by_name,
  r.version
`;

function iso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toArticle(row: ArticleRow): ArticleRecord {
  return {
    id: row.id,
    title: row.title,
    content: row.content ?? '',
    tags: row.tags,
    visibility: row.visibility,
    isPinned: row.is_pinned,
    isProtected: row.is_protected,
    isVerified: row.is_verified,
    createdAt: iso(row.created_at),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    modifiedAt: iso(row.modified_at),
    modifiedBy: row.modified_by,
    modifiedByName: row.modified_by_name,
    version: row.version,
  };
}

function toRevision(row: ArticleRevisionRow): ArticleRevisionRecord {
  return {
    articleId: row.article_id,
    title: row.title,
    content: row.content,
    tags: row.tags,
    visibility: row.visibility,
    isPinned: row.is_pinned,
    isProtected: row.is_protected,
    isVerified: row.is_verified,
    revisedAt: iso(row.revised_at),
    revisedBy: row.revised_by,
    revisedByName: row.revised_by_name,
    version: row.version,
  };
}

function excerpt(markdown: string) {
  return markdown
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!??\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

async function upsertActor(client: pg.PoolClient, actor: Actor) {
  await client.query(
    `INSERT INTO app_users (cognito_sub, display_name, email, last_seen_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (cognito_sub) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           email = EXCLUDED.email,
           last_seen_at = now()`,
    [actor.sub, actor.displayName, actor.email ?? null],
  );
}

async function recordRevision(client: pg.PoolClient, id: string) {
  await client.query(
    `INSERT INTO article_revisions (
       article_id, version, title, content, tags, visibility, is_pinned, is_protected, is_verified, revised_at, revised_by
     )
     SELECT id, version, title, content, tags, visibility, is_pinned, is_protected, is_verified, modified_at, modified_by
     FROM articles
     WHERE id = $1`,
    [id],
  );
  await client.query(
    `DELETE FROM article_revisions
     WHERE article_id = $1
       AND version NOT IN (
         SELECT version
         FROM article_revisions
         WHERE article_id = $1
         ORDER BY version DESC
         LIMIT 5
       )`,
    [id],
  );
}

export class PostgresArticleRepository implements ArticleRepository {
  async list(query: ListArticlesQuery, viewerRole: Role | null): Promise<ArticleListResult> {
    const pool = await getPool();
    const conditions = [
      `($1 = '' OR a.search_vector @@ websearch_to_tsquery('simple', $1))`,
      `($2 = '' OR $2 = ANY(a.tags))`,
      `($3 = 'all' OR a.is_pinned)`,
      `($4 = 'all' OR ($4 = 'protected' AND a.is_protected) OR ($4 = 'unprotected' AND NOT a.is_protected))`,
      `($5 = 'all' OR lower(a.visibility) = $5)`,
      `($6 = 'all' OR ($6 = 'verified' AND a.is_verified) OR ($6 = 'unverified' AND NOT a.is_verified))`,
      `($7::text = 'Admin' OR a.visibility = 'Public' OR ($7::text = 'Standard' AND a.visibility = 'Internal'))`,
    ];
    const where = conditions.join(' AND ');
    const sortColumns = { createdAt: 'a.created_at', modifiedAt: 'a.modified_at', title: 'lower(a.title)' } as const;
    const direction = query.direction === 'asc' ? 'ASC' : 'DESC';
    const offset = (query.page - 1) * query.pageSize;
    const params = [query.search, query.tag, query.pinned, query.protection, query.visibility, query.verification, viewerRole];

    const [countResult, dataResult] = await Promise.all([
      pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM articles a WHERE ${where}`, params),
      pool.query<ArticleRow>(
        `SELECT
           a.id, a.title, left(a.content, 1000) AS content_preview, a.tags, a.visibility, a.is_pinned, a.is_protected, a.is_verified,
           a.created_at, a.created_by, creator.display_name AS created_by_name,
           a.modified_at, a.modified_by, editor.display_name AS modified_by_name,
           a.version
         FROM articles a
         JOIN app_users creator ON creator.cognito_sub = a.created_by
         JOIN app_users editor ON editor.cognito_sub = a.modified_by
         WHERE ${where}
         ORDER BY a.is_pinned DESC, ${sortColumns[query.sort]} ${direction}, a.id ${direction}
         LIMIT $8 OFFSET $9`,
        [...params, query.pageSize, offset],
      ),
    ]);

    const total = Number(countResult.rows[0]?.count ?? 0);
    return {
      items: dataResult.rows.map((row) => {
        return {
          id: row.id,
          title: row.title,
          excerpt: excerpt(row.content_preview ?? ''),
          tags: row.tags,
          visibility: row.visibility,
          isPinned: row.is_pinned,
          isProtected: row.is_protected,
          isVerified: row.is_verified,
          createdAt: iso(row.created_at),
          createdBy: row.created_by,
          createdByName: row.created_by_name,
          modifiedAt: iso(row.modified_at),
          modifiedBy: row.modified_by,
          modifiedByName: row.modified_by_name,
          version: row.version,
        };
      }),
      page: query.page,
      pageSize: query.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / query.pageSize)),
    };
  }

  async get(id: string, viewerRole: Role | null) {
    const pool = await getPool();
    const result = await pool.query<ArticleRow>(
      `SELECT ${baseSelect}
       FROM articles a
       JOIN app_users creator ON creator.cognito_sub = a.created_by
       JOIN app_users editor ON editor.cognito_sub = a.modified_by
       WHERE a.id = $1
         AND ($2::text = 'Admin' OR a.visibility = 'Public' OR ($2::text = 'Standard' AND a.visibility = 'Internal'))`,
      [id, viewerRole],
    );
    return result.rows[0] ? toArticle(result.rows[0]) : null;
  }

  async listRevisions(id: string) {
    const pool = await getPool();
    const result = await pool.query<ArticleRevisionRow>(
      `SELECT ${revisionSelect}
       FROM article_revisions r
       JOIN app_users editor ON editor.cognito_sub = r.revised_by
       WHERE r.article_id = $1
       ORDER BY r.version DESC
       LIMIT 5`,
      [id],
    );
    return result.rows.map(toRevision);
  }

  async getRevision(id: string, version: number) {
    const pool = await getPool();
    const result = await pool.query<ArticleRevisionRow>(
      `SELECT ${revisionSelect}
       FROM article_revisions r
       JOIN app_users editor ON editor.cognito_sub = r.revised_by
       WHERE r.article_id = $1 AND r.version = $2`,
      [id, version],
    );
    return result.rows[0] ? toRevision(result.rows[0]) : null;
  }

  async create(input: ArticleWrite, actor: Actor) {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await upsertActor(client, actor);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO articles (title, content, tags, visibility, created_by, modified_by)
         VALUES ($1, $2, $3::text[], $4, $5, $5)
         RETURNING id`,
        [input.title, input.content, input.tags, input.visibility ?? 'Internal', actor.sub],
      );
      await recordRevision(client, inserted.rows[0].id);
      await client.query('COMMIT');
      return (await this.get(inserted.rows[0].id, actor.role))!;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async update(id: string, input: ArticleWrite & { version: number }, actor: Actor) {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await upsertActor(client, actor);
      const updated = await client.query<{ id: string }>(
        `UPDATE articles
         SET title = $1,
             content = $2,
             tags = $3::text[],
             visibility = $4,
             modified_by = $5,
             modified_at = now(),
             version = version + 1
         WHERE id = $6
           AND version = $7
           AND (NOT is_protected OR $8::boolean)
           AND ($8::boolean OR $4 <> 'Admin')
         RETURNING id`,
        [input.title, input.content, input.tags, input.visibility ?? 'Internal', actor.sub, id, input.version, actor.role === 'Admin'],
      );
      if (updated.rows[0]) await recordRevision(client, updated.rows[0].id);
      await client.query('COMMIT');
      return updated.rows[0] ? this.get(updated.rows[0].id, actor.role) : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async setProtection(id: string, isProtected: boolean, version: number, actor: Actor) {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await upsertActor(client, actor);
      const updated = await client.query<{ id: string }>(
        `UPDATE articles
         SET is_protected = $1,
             modified_by = $2,
             modified_at = now(),
             version = version + 1
         WHERE id = $3 AND version = $4
         RETURNING id`,
        [isProtected, actor.sub, id, version],
      );
      if (updated.rows[0]) await recordRevision(client, updated.rows[0].id);
      await client.query('COMMIT');
      return updated.rows[0] ? this.get(updated.rows[0].id, actor.role) : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async setPinned(id: string, isPinned: boolean, version: number, actor: Actor) {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await upsertActor(client, actor);
      const updated = await client.query<{ id: string }>(
        `UPDATE articles
         SET is_pinned = $1,
             modified_by = $2,
             modified_at = now(),
             version = version + 1
         WHERE id = $3 AND version = $4
         RETURNING id`,
        [isPinned, actor.sub, id, version],
      );
      if (updated.rows[0]) await recordRevision(client, updated.rows[0].id);
      await client.query('COMMIT');
      return updated.rows[0] ? this.get(updated.rows[0].id, actor.role) : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async setVerified(id: string, isVerified: boolean, version: number, actor: Actor) {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await upsertActor(client, actor);
      const updated = await client.query<{ id: string }>(
        `UPDATE articles
         SET is_verified = $1,
             modified_by = $2,
             modified_at = now(),
             version = version + 1
         WHERE id = $3 AND version = $4
         RETURNING id`,
        [isVerified, actor.sub, id, version],
      );
      if (updated.rows[0]) await recordRevision(client, updated.rows[0].id);
      await client.query('COMMIT');
      return updated.rows[0] ? this.get(updated.rows[0].id, actor.role) : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async restore(id: string, revisionVersion: number, currentVersion: number, actor: Actor) {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await upsertActor(client, actor);
      const updated = await client.query<{ id: string }>(
        `UPDATE articles AS a
         SET title = r.title,
             content = r.content,
             tags = r.tags,
             visibility = r.visibility,
             is_pinned = r.is_pinned,
             is_protected = r.is_protected,
             is_verified = r.is_verified,
             modified_by = $4,
             modified_at = now(),
             version = a.version + 1
         FROM article_revisions r
         WHERE a.id = $1
           AND a.version = $3
           AND r.article_id = a.id
           AND r.version = $2
         RETURNING a.id`,
        [id, revisionVersion, currentVersion, actor.sub],
      );
      if (updated.rows[0]) await recordRevision(client, updated.rows[0].id);
      await client.query('COMMIT');
      return updated.rows[0] ? this.get(updated.rows[0].id, actor.role) : null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  async delete(id: string, version: number) {
    const pool = await getPool();
    const result = await pool.query('DELETE FROM articles WHERE id = $1 AND version = $2', [id, version]);
    return result.rowCount === 1;
  }
}
