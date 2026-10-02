BEGIN;

ALTER TABLE articles
  ADD COLUMN is_verified boolean NOT NULL DEFAULT false;

ALTER TABLE article_revisions
  ADD COLUMN is_verified boolean NOT NULL DEFAULT false;

INSERT INTO schema_migrations (id) VALUES ('005_article_verification');

COMMIT;
