BEGIN;

DROP INDEX local_users_single_super_admin;
ALTER TABLE local_users DROP COLUMN is_super_admin;

COMMIT;
