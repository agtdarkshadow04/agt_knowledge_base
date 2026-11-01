BEGIN;

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

INSERT INTO schema_migrations (id) VALUES ('002_article_revisions');
COMMIT;
