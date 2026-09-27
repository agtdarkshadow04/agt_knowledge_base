BEGIN;

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

CREATE TABLE IF NOT EXISTS schema_migrations (
  id text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (id) VALUES ('001_initial') ON CONFLICT DO NOTHING;
COMMIT;
