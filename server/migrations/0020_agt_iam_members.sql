-- AGT IAM sign-in (issue #30): the iam.enabled dashboard setting (CFG-6).
ALTER TABLE settings DROP CONSTRAINT settings_key_check;
ALTER TABLE settings ADD CONSTRAINT settings_key_check CHECK (key IN (
  'site.title', 'site.subtitle', 'site.supportUrl', 'articles.defaultVisibility',
  'access.allowPublicBrowsing', 'backup.maxZipBytes', 'backup.maxUncompressedBytes', 'backup.maxEntries',
  'logs.serverRetentionDays', 'logs.serverMaxEntries', 'logs.auditRetentionDays', 'logs.auditMaxEntries',
  'iam.enabled'
));

-- Members who sign in through AGT IAM have no local username or password; they
-- are found by their AGT traveller ID, and their name and role come from IAM.
ALTER TABLE local_users
  ADD COLUMN auth_source text NOT NULL DEFAULT 'local',
  ADD COLUMN iam_traveller_id text,
  ADD COLUMN iam_traveller_name text,
  ADD COLUMN iam_permission text,
  ADD COLUMN iam_synced_at timestamptz,
  ALTER COLUMN username DROP NOT NULL,
  ALTER COLUMN password_hash DROP NOT NULL,
  ADD CONSTRAINT local_users_auth_source_check CHECK (auth_source IN ('local', 'agt_iam')),
  ADD CONSTRAINT local_users_iam_traveller_id_key UNIQUE (iam_traveller_id),
  ADD CONSTRAINT local_users_iam_traveller_id_length CHECK (char_length(iam_traveller_id) BETWEEN 1 AND 200),
  ADD CONSTRAINT local_users_iam_traveller_name_length CHECK (char_length(iam_traveller_name) BETWEEN 1 AND 42),
  ADD CONSTRAINT local_users_iam_permission_length CHECK (char_length(iam_permission) <= 200),
  ADD CONSTRAINT local_users_auth_source_columns CHECK (
    (auth_source = 'local' AND username IS NOT NULL AND password_hash IS NOT NULL
      AND iam_traveller_id IS NULL AND iam_traveller_name IS NULL AND iam_permission IS NULL AND iam_synced_at IS NULL)
    OR (auth_source = 'agt_iam' AND username IS NULL AND password_hash IS NULL AND email IS NULL
      AND iam_traveller_id IS NOT NULL AND iam_traveller_name IS NOT NULL)
  );
