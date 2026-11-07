BEGIN;

-- Moves the super administrator out of local_users into the single-row admin
-- table and adds Admin sessions. Member roles are renamed (Admin -> Moderator,
-- Standard -> Editor) and every member session is revoked. The super-admin's
-- user_id stays in app_users, so authorship and history are kept. Migration
-- 014_admin_account_contract later drops the unused is_super_admin column.

LOCK TABLE local_users IN ACCESS EXCLUSIVE MODE;

CREATE TABLE admin (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  username varchar(64) NOT NULL
    CHECK (username = lower(username) AND username ~ '^[a-z0-9_.-]{3,64}$'),
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE admin_sessions (
  token_hash char(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX admin_sessions_expires_idx ON admin_sessions (expires_at);

INSERT INTO admin (username, password_hash, created_at)
SELECT username, password_hash, created_at
FROM local_users
WHERE is_super_admin
LIMIT 1;

DELETE FROM local_users WHERE is_super_admin;

ALTER TABLE local_users DROP CONSTRAINT local_users_role_check;

UPDATE local_users
SET role = CASE role WHEN 'Admin' THEN 'Moderator' ELSE 'Editor' END,
    session_version = session_version + 1,
    updated_at = now();

ALTER TABLE local_users
  ADD CONSTRAINT local_users_role_check CHECK (role IN ('Editor', 'Moderator'));

COMMIT;
