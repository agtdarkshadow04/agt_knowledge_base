export interface Migration {
  id: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: '001_initial',
    sql: `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS app_users (
        cognito_sub text PRIMARY KEY,
        display_name varchar(120) NOT NULL,
        email varchar(254),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS articles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title varchar(180) NOT NULL CHECK (char_length(title) >= 3),
        content text NOT NULL CHECK (char_length(content) BETWEEN 20 AND 250000),
        tags text[] NOT NULL DEFAULT '{}',
        is_protected boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        created_by text NOT NULL REFERENCES app_users(cognito_sub),
        modified_at timestamptz NOT NULL DEFAULT now(),
        modified_by text NOT NULL REFERENCES app_users(cognito_sub),
        version integer NOT NULL DEFAULT 1 CHECK (version > 0),
        search_vector tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('simple', coalesce(content, '')), 'B')
        ) STORED
      );

      CREATE INDEX IF NOT EXISTS articles_search_idx ON articles USING gin(search_vector);
      CREATE INDEX IF NOT EXISTS articles_tags_idx ON articles USING gin(tags);
      CREATE INDEX IF NOT EXISTS articles_modified_idx ON articles (modified_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS articles_created_idx ON articles (created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS articles_title_idx ON articles (lower(title), id);
    `,
  },
  {
    id: '002_article_revisions',
    sql: `
      CREATE TABLE article_revisions (
        article_id uuid NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
        version integer NOT NULL CHECK (version > 0),
        title varchar(180) NOT NULL CHECK (char_length(title) >= 3),
        content text NOT NULL CHECK (char_length(content) BETWEEN 20 AND 250000),
        tags text[] NOT NULL DEFAULT '{}',
        is_protected boolean NOT NULL,
        revised_at timestamptz NOT NULL,
        revised_by text NOT NULL REFERENCES app_users(cognito_sub),
        PRIMARY KEY (article_id, version)
      );

      INSERT INTO article_revisions (
        article_id, version, title, content, tags, is_protected, revised_at, revised_by
      )
      SELECT id, version, title, content, tags, is_protected, modified_at, modified_by
      FROM articles;
    `,
  },
  {
    id: '003_article_pinning',
    sql: `
      ALTER TABLE articles
        ADD COLUMN is_pinned boolean NOT NULL DEFAULT false;

      ALTER TABLE article_revisions
        ADD COLUMN is_pinned boolean NOT NULL DEFAULT false;

      CREATE INDEX articles_pinned_modified_idx
        ON articles (is_pinned DESC, modified_at DESC, id DESC);
    `,
  },
];
