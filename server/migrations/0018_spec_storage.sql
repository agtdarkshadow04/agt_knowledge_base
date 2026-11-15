-- DATA-11: the public schema holds only tables, sequences, indexes and
-- constraints. The last function goes; the server merges orphaned tag IDs itself.
DROP FUNCTION IF EXISTS merge_preserved_orphan_tag_ids(uuid[], uuid[]);

-- DATA-6: the server generates IDs with crypto.randomUUID(), so no column
-- default needs gen_random_uuid() or the pgcrypto extension any more.
ALTER TABLE articles ALTER COLUMN id DROP DEFAULT;
ALTER TABLE tags ALTER COLUMN id DROP DEFAULT;
ALTER TABLE local_users ALTER COLUMN id DROP DEFAULT;

-- The extension can only be dropped by its owner. On a database upgraded from
-- 1.x the bootstrap superuser owns it, and deploy/upgrade-database-role.sql drops it.
DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_extension
    WHERE extname = 'pgcrypto' AND extowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  ) THEN
    DROP EXTENSION pgcrypto;
  END IF;
END;
$migration$;

-- DATA-11: text rather than varchar(n) or char(n); the lengths stay enforced.
ALTER TABLE app_users
  ALTER COLUMN display_name TYPE text,
  ALTER COLUMN email TYPE text,
  ADD CONSTRAINT app_users_display_name_length CHECK (char_length(display_name) <= 120),
  ADD CONSTRAINT app_users_email_length CHECK (email IS NULL OR char_length(email) <= 254);

-- The generated search column depends on title, so it is rebuilt around the type change.
ALTER TABLE articles DROP COLUMN search_vector;
ALTER TABLE articles
  ALTER COLUMN title TYPE text,
  ADD CONSTRAINT articles_title_length CHECK (char_length(title) <= 180),
  ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(content, '')), 'B')
  ) STORED;
CREATE INDEX articles_search_idx ON articles USING gin (search_vector);

ALTER TABLE article_revisions
  ALTER COLUMN title TYPE text,
  ADD CONSTRAINT article_revisions_title_length CHECK (char_length(title) <= 180);

ALTER TABLE tags
  ALTER COLUMN name TYPE text,
  ALTER COLUMN color TYPE text,
  ADD CONSTRAINT tags_name_length CHECK (char_length(name) <= 40),
  ADD CONSTRAINT tags_color_length CHECK (char_length(color) <= 7);

ALTER TABLE local_users
  ALTER COLUMN username TYPE text,
  ALTER COLUMN display_name TYPE text,
  ALTER COLUMN email TYPE text,
  ALTER COLUMN role TYPE text,
  ADD CONSTRAINT local_users_email_length CHECK (email IS NULL OR char_length(email) <= 254);

ALTER TABLE admin ALTER COLUMN username TYPE text;
ALTER TABLE sessions ALTER COLUMN token_hash TYPE text;
ALTER TABLE member_sessions ALTER COLUMN token_hash TYPE text;

-- DATA-8: every table that is not a pure join or log table has created_at and
-- updated_at. article_revisions is the revision log and keeps revised_at.
ALTER TABLE articles RENAME COLUMN modified_at TO updated_at;
ALTER TABLE app_users ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE member_sessions ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
