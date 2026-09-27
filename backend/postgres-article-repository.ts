import type pg from 'pg';
import type { Actor, ArticleListResult, ArticleRecord, ArticleWrite, ListArticlesQuery } from './domain.js';
import { getPool } from './db.js';
import type { ArticleRepository } from './repository.js';

interface ArticleRow {
  id: string;
  title: string;
  content?: string;
  content_preview?: string;
  tags: string[];
  is_protected: boolean;
  created_at: Date | string;
  created_by: string;
  created_by_name: string;
  modified_at: Date | string;
  modified_by: string;
  modified_by_name: string;
  version: number;
}

const baseSelect = `
  a.id, a.title, a.content, a.tags, a.is_protected,
  a.created_at, a.created_by, creator.display_name AS created_by_name,
  a.modified_at, a.modified_by, editor.display_name AS modified_by_name,
  a.version
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
    isProtected: row.is_protected,
    createdAt: iso(row.created_at),
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    modifiedAt: iso(row.modified_at),
    modifiedBy: row.modified_by,
    modifiedByName: row.modified_by_name,
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

export class PostgresArticleRepository implements ArticleRepository {
  async list(query: ListArticlesQuery): Promise<ArticleListResult> {
    const pool = await getPool();
    const conditions = [
      `($1 = '' OR a.search_vector @@ websearch_to_tsquery('simple', $1))`,
      `($2 = '' OR $2 = ANY(a.tags))`,
      `($3 = 'all' OR ($3 = 'protected' AND a.is_protected) OR ($3 = 'unprotected' AND NOT a.is_protected))`,
    ];
    const where = conditions.join(' AND ');
    const sortColumns = { createdAt: 'a.created_at', modifiedAt: 'a.modified_at', title: 'lower(a.title)' } as const;
    const direction = query.direction === 'asc' ? 'ASC' : 'DESC';
    const offset = (query.page - 1) * query.pageSize;
    const params = [query.search, query.tag, query.protection];

    const [countResult, dataResult] = await Promise.all([
      pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM articles a WHERE ${where}`, params),
      pool.query<ArticleRow>(
        `SELECT
           a.id, a.title, left(a.content, 1000) AS content_preview, a.tags, a.is_protected,
           a.created_at, a.created_by, creator.display_name AS created_by_name,
           a.modified_at, a.modified_by, editor.display_name AS modified_by_name,
           a.version
         FROM articles a
         JOIN app_users creator ON creator.cognito_sub = a.created_by
         JOIN app_users editor ON editor.cognito_sub = a.modified_by
         WHERE ${where}
         ORDER BY ${sortColumns[query.sort]} ${direction}, a.id ${direction}
         LIMIT $4 OFFSET $5`,
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
          isProtected: row.is_protected,
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

  async get(id: string) {
    const pool = await getPool();
    const result = await pool.query<ArticleRow>(
      `SELECT ${baseSelect}
       FROM articles a
       JOIN app_users creator ON creator.cognito_sub = a.created_by
       JOIN app_users editor ON editor.cognito_sub = a.modified_by
       WHERE a.id = $1`,
      [id],
    );
    return result.rows[0] ? toArticle(result.rows[0]) : null;
  }

  async create(input: ArticleWrite, actor: Actor) {
    const pool = await getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await upsertActor(client, actor);
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO articles (title, content, tags, created_by, modified_by)
         VALUES ($1, $2, $3::text[], $4, $4)
         RETURNING id`,
        [input.title, input.content, input.tags, actor.sub],
      );
      await client.query('COMMIT');
      return (await this.get(inserted.rows[0].id))!;
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
             modified_by = $4,
             modified_at = now(),
             version = version + 1
         WHERE id = $5
           AND version = $6
           AND (NOT is_protected OR $7::boolean)
         RETURNING id`,
        [input.title, input.content, input.tags, actor.sub, id, input.version, actor.role === 'Admin'],
      );
      await client.query('COMMIT');
      return updated.rows[0] ? this.get(updated.rows[0].id) : null;
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
      await client.query('COMMIT');
      return updated.rows[0] ? this.get(updated.rows[0].id) : null;
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
