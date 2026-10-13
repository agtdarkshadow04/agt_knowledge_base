BEGIN;

LOCK TABLE articles, article_revisions, application_settings IN ACCESS EXCLUSIVE MODE;

DROP INDEX articles_visibility_modified_idx;

ALTER TABLE articles
  DROP CONSTRAINT articles_visibility_check,
  ALTER COLUMN visibility DROP DEFAULT,
  ALTER COLUMN visibility TYPE jsonb USING to_jsonb(visibility),
  ALTER COLUMN visibility SET DEFAULT '"Internal"'::jsonb,
  ADD CONSTRAINT articles_visibility_check CHECK (
    (jsonb_typeof(visibility) = 'string' AND visibility IN ('"Public"'::jsonb, '"Internal"'::jsonb, '"Admin"'::jsonb))
    OR (jsonb_typeof(visibility) = 'number' AND visibility IN ('0'::jsonb, '1'::jsonb, '2'::jsonb, '3'::jsonb, '4'::jsonb, '5'::jsonb))
  );

ALTER TABLE article_revisions
  DROP CONSTRAINT article_revisions_visibility_check,
  ALTER COLUMN visibility DROP DEFAULT,
  ALTER COLUMN visibility TYPE jsonb USING to_jsonb(visibility),
  ALTER COLUMN visibility SET DEFAULT '"Internal"'::jsonb,
  ADD CONSTRAINT article_revisions_visibility_check CHECK (
    (jsonb_typeof(visibility) = 'string' AND visibility IN ('"Public"'::jsonb, '"Internal"'::jsonb, '"Admin"'::jsonb))
    OR (jsonb_typeof(visibility) = 'number' AND visibility IN ('0'::jsonb, '1'::jsonb, '2'::jsonb, '3'::jsonb, '4'::jsonb, '5'::jsonb))
  );

ALTER TABLE application_settings
  DROP CONSTRAINT application_settings_default_visibility_check,
  ALTER COLUMN default_visibility TYPE jsonb USING to_jsonb(default_visibility),
  ADD CONSTRAINT application_settings_default_visibility_check CHECK (
    (jsonb_typeof(default_visibility) = 'string' AND default_visibility IN ('"Public"'::jsonb, '"Internal"'::jsonb, '"Admin"'::jsonb))
    OR (jsonb_typeof(default_visibility) = 'number' AND default_visibility IN ('0'::jsonb, '1'::jsonb, '2'::jsonb, '3'::jsonb, '4'::jsonb, '5'::jsonb))
  );

CREATE INDEX articles_visibility_modified_idx
  ON articles (visibility, modified_at DESC, id DESC);

INSERT INTO schema_migrations (id) VALUES ('010_agt_visibility');
COMMIT;
