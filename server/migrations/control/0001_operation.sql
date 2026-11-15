-- BAK-12: the shared state of the backup and restore operation lock. The
-- control schema is never dumped or restored, so it survives every restore.
CREATE TABLE control.operation (
  id integer PRIMARY KEY CHECK (id = 1),
  state text NOT NULL CHECK (state IN ('idle', 'backup', 'restore', 'restore_failed')),
  generation bigint NOT NULL,
  owner uuid,                  -- process running the operation (crypto.randomUUID() at startup)
  started_at timestamptz,
  pre_restore_backup text,     -- file name, set once BAK-4 step 3 has written it
  admin_session_hash text,     -- BAK-11 recovery session: SHA-256 of the restoring admin's session token,
  admin_username text,         --   their username,
  admin_session_expires_at timestamptz  --   and that session's expiry (AUTH-8)
);
INSERT INTO control.operation (id, state, generation) VALUES (1, 'idle', 0);
