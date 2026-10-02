BEGIN;

ALTER TABLE articles
  ADD COLUMN visibility varchar(16) NOT NULL DEFAULT 'Internal'
  CHECK (visibility IN ('Public', 'Internal', 'Admin'));

ALTER TABLE article_revisions
  ADD COLUMN visibility varchar(16) NOT NULL DEFAULT 'Internal'
  CHECK (visibility IN ('Public', 'Internal', 'Admin'));

CREATE INDEX articles_visibility_modified_idx
  ON articles (visibility, modified_at DESC, id DESC);

INSERT INTO schema_migrations (id) VALUES ('004_article_visibility');
COMMIT;
