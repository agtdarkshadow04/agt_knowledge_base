BEGIN;

-- The user key held Cognito subjects. Give it a provider-neutral name; foreign
-- keys from articles and article_revisions follow the renamed column.
ALTER TABLE app_users RENAME COLUMN cognito_sub TO user_id;

COMMIT;
