ALTER TABLE local_users
  ADD COLUMN is_super_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN session_version integer NOT NULL DEFAULT 1 CHECK (session_version > 0);

DO $migration$
BEGIN
  IF EXISTS (SELECT 1 FROM local_users) THEN
    IF NOT EXISTS (SELECT 1 FROM local_users WHERE is_active AND role = 'Admin') THEN
      RAISE EXCEPTION 'Local users exist but no active Admin is available. Use the recovery command to activate or create an Admin, then rerun this migration.';
    END IF;

    UPDATE local_users
    SET is_super_admin = true,
        updated_at = now()
    WHERE id = (
      SELECT id
      FROM local_users
      WHERE is_active AND role = 'Admin'
      ORDER BY created_at, id
      LIMIT 1
    );
  END IF;
END;
$migration$;

CREATE UNIQUE INDEX local_users_single_super_admin
  ON local_users (is_super_admin)
  WHERE is_super_admin;

CREATE TABLE application_settings (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  application_name varchar(80) NOT NULL CHECK (char_length(btrim(application_name)) BETWEEN 1 AND 80),
  application_subtitle varchar(240) NOT NULL CHECK (char_length(btrim(application_subtitle)) BETWEEN 1 AND 240),
  default_visibility varchar(16) NOT NULL CHECK (default_visibility IN ('Public', 'Internal', 'Admin')),
  allow_public_browsing boolean NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO application_settings (
  application_name,
  application_subtitle,
  default_visibility,
  allow_public_browsing
) VALUES (
  'AGT Knowledge Base',
  'Field-tested guides, community procedures, and traveller intelligence.',
  'Internal',
  true
);
