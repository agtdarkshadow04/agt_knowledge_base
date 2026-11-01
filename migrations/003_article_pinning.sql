BEGIN;

ALTER TABLE articles
  ADD COLUMN is_pinned boolean NOT NULL DEFAULT false;

ALTER TABLE article_revisions
  ADD COLUMN is_pinned boolean NOT NULL DEFAULT false;

CREATE INDEX articles_pinned_modified_idx
  ON articles (is_pinned DESC, modified_at DESC, id DESC);

INSERT INTO schema_migrations (id) VALUES ('003_article_pinning');
COMMIT;
