BEGIN;

-- AUTH-2: 1.x hashes (scrypt$<salt base64url>$<hash base64url>, Node's default
-- N=16384, r=8, p=1) become the six-field format with standard base64. The
-- server rehashes them with the current profile on the next successful sign-in.
UPDATE admin
SET password_hash = 'scrypt$16384$8$1$'
  || translate(split_part(password_hash, '$', 2), '-_', '+/') || '==$'
  || translate(split_part(password_hash, '$', 3), '-_', '+/') || '=='
WHERE password_hash ~ '^scrypt\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$';

UPDATE local_users
SET password_hash = 'scrypt$16384$8$1$'
  || translate(split_part(password_hash, '$', 2), '-_', '+/') || '==$'
  || translate(split_part(password_hash, '$', 3), '-_', '+/') || '=='
WHERE password_hash ~ '^scrypt\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{86}$';

-- AUTH-3: the Admin username is stored as entered after trimming, 1-64 characters.
ALTER TABLE admin
  DROP CONSTRAINT admin_username_check,
  ADD CONSTRAINT admin_username_check
    CHECK (char_length(username) BETWEEN 1 AND 64 AND username !~ '^\s' AND username !~ '\s$');

-- AUTH-8: the Admin's sessions table is sessions; the new cookie signs everyone in again.
DELETE FROM admin_sessions;
ALTER TABLE admin_sessions RENAME TO sessions;
ALTER TABLE sessions RENAME CONSTRAINT admin_sessions_pkey TO sessions_pkey;
ALTER TABLE sessions RENAME CONSTRAINT admin_sessions_token_hash_check TO sessions_token_hash_check;
ALTER INDEX admin_sessions_expires_idx RENAME TO sessions_expires_idx;

-- Member cookie sessions (AUTH-1 deviation): only the SHA-256 of the token is stored.
CREATE TABLE member_sessions (
  token_hash char(64) PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES local_users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE INDEX member_sessions_user_idx ON member_sessions (user_id);
CREATE INDEX member_sessions_expires_idx ON member_sessions (expires_at);

COMMIT;
