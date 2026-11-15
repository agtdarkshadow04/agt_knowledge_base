export interface Migration {
  id: string;
  sql: string;
  requiresExplicitTarget?: boolean;
}

export const canonicalTagsExpandSql = `
  CREATE TABLE tags (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name varchar(40) NOT NULL,
    color varchar(7) NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT tags_name_valid CHECK (
      name = btrim(name) AND char_length(name) BETWEEN 1 AND 40
    ),
    CONSTRAINT tags_color_valid CHECK (color ~ '^#[0-9A-F]{6}$')
  );

  CREATE UNIQUE INDEX tags_name_ci_key ON tags ((lower(name)));

  CREATE FUNCTION legacy_tag_color(value text) RETURNS varchar(7)
  LANGUAGE plpgsql IMMUTABLE STRICT AS $migration$
  DECLARE
    hash_value bigint := 0;
    character_index integer;
    code_point integer;
    red integer;
    green integer;
    blue integer;
  BEGIN
    FOR character_index IN 1..char_length(value) LOOP
      code_point := ascii(substr(value, character_index, 1));
      IF code_point > 65535 THEN
        hash_value := mod(
          hash_value * 31 + 55296 + ((code_point - 65536) / 1024),
          4294967296::bigint
        );
        code_point := 56320 + mod(code_point - 65536, 1024);
      END IF;
      hash_value := mod(hash_value * 31 + code_point, 4294967296::bigint);
    END LOOP;

    red := (((hash_value >> 0) & 255) + 255) / 2;
    green := (((hash_value >> 8) & 255) + 255) / 2;
    blue := (((hash_value >> 16) & 255) + 255) / 2;
    RETURN upper(
      '#' || lpad(to_hex(red), 2, '0') || lpad(to_hex(green), 2, '0') || lpad(to_hex(blue), 2, '0')
    );
  END;
  $migration$;

  DO $migration$
  BEGIN
    IF legacy_tag_color('portal') <> '#B5C3B7'
      OR legacy_tag_color('guide') <> '#FD9CF0' THEN
      RAISE EXCEPTION 'Legacy tag color parity check failed';
    END IF;
  END;
  $migration$;

  LOCK TABLE articles, article_revisions IN ACCESS EXCLUSIVE MODE;

  WITH legacy_names AS (
    SELECT lower(btrim(legacy.tag_name)) AS name
    FROM articles article
    CROSS JOIN LATERAL unnest(article.tags) AS legacy(tag_name)
    WHERE btrim(legacy.tag_name) <> ''
    UNION
    SELECT lower(btrim(legacy.tag_name))
    FROM article_revisions revision
    CROSS JOIN LATERAL unnest(revision.tags) AS legacy(tag_name)
    WHERE btrim(legacy.tag_name) <> ''
  )
  INSERT INTO tags (name, color)
  SELECT name, legacy_tag_color(name)
  FROM legacy_names;

  ALTER TABLE articles
    ADD COLUMN tag_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

  ALTER TABLE article_revisions
    ADD COLUMN tag_ids uuid[] NOT NULL DEFAULT '{}'::uuid[];

  UPDATE articles article
  SET tag_ids = COALESCE((
    SELECT array_agg(catalog.id ORDER BY normalized.first_position)
    FROM (
      SELECT
        lower(btrim(legacy.tag_name)) AS name,
        min(legacy.position) AS first_position
      FROM unnest(article.tags) WITH ORDINALITY AS legacy(tag_name, position)
      WHERE btrim(legacy.tag_name) <> ''
      GROUP BY lower(btrim(legacy.tag_name))
    ) normalized
    JOIN tags catalog ON lower(catalog.name) = normalized.name
  ), '{}'::uuid[]);

  UPDATE article_revisions revision
  SET tag_ids = COALESCE((
    SELECT array_agg(catalog.id ORDER BY normalized.first_position)
    FROM (
      SELECT
        lower(btrim(legacy.tag_name)) AS name,
        min(legacy.position) AS first_position
      FROM unnest(revision.tags) WITH ORDINALITY AS legacy(tag_name, position)
      WHERE btrim(legacy.tag_name) <> ''
      GROUP BY lower(btrim(legacy.tag_name))
    ) normalized
    JOIN tags catalog ON lower(catalog.name) = normalized.name
  ), '{}'::uuid[]);

  DO $migration$
  BEGIN
    IF EXISTS (
      SELECT 1
      FROM (
        SELECT legacy.tag_name
        FROM articles article
        CROSS JOIN LATERAL unnest(article.tags) AS legacy(tag_name)
        UNION ALL
        SELECT legacy.tag_name
        FROM article_revisions revision
        CROSS JOIN LATERAL unnest(revision.tags) AS legacy(tag_name)
      ) all_legacy
      LEFT JOIN tags catalog ON lower(catalog.name) = lower(btrim(all_legacy.tag_name))
      WHERE btrim(all_legacy.tag_name) <> '' AND catalog.id IS NULL
    ) THEN
      RAISE EXCEPTION 'Canonical tag migration left legacy values unmapped';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM articles article
      WHERE cardinality(article.tag_ids) <> (
        SELECT count(DISTINCT lower(btrim(legacy.tag_name)))
        FROM unnest(article.tags) AS legacy(tag_name)
        WHERE btrim(legacy.tag_name) <> ''
      )
    ) OR EXISTS (
      SELECT 1
      FROM article_revisions revision
      WHERE cardinality(revision.tag_ids) <> (
        SELECT count(DISTINCT lower(btrim(legacy.tag_name)))
        FROM unnest(revision.tags) AS legacy(tag_name)
        WHERE btrim(legacy.tag_name) <> ''
      )
    ) THEN
      RAISE EXCEPTION 'Canonical tag migration did not preserve normalized tag cardinality';
    END IF;
  END;
  $migration$;

  CREATE INDEX articles_tag_ids_idx ON articles USING gin(tag_ids);

  DROP FUNCTION legacy_tag_color(text);

  CREATE FUNCTION canonical_tag_ids_from_legacy(legacy_tags text[]) RETURNS uuid[]
  LANGUAGE plpgsql STABLE STRICT AS $migration$
  DECLARE
    mapped_ids uuid[];
  BEGIN
    IF EXISTS (
      SELECT 1
      FROM (
        SELECT lower(btrim(legacy.tag_name)) AS name
        FROM unnest(legacy_tags) AS legacy(tag_name)
        WHERE btrim(legacy.tag_name) <> ''
        GROUP BY lower(btrim(legacy.tag_name))
      ) normalized
      LEFT JOIN tags catalog ON lower(catalog.name) = normalized.name
      WHERE catalog.id IS NULL
    ) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Legacy article writes may only use existing canonical tag names';
    END IF;

    SELECT COALESCE(array_agg(catalog.id ORDER BY normalized.first_position), '{}'::uuid[])
    INTO mapped_ids
    FROM (
      SELECT
        lower(btrim(legacy.tag_name)) AS name,
        min(legacy.position) AS first_position
      FROM unnest(legacy_tags) WITH ORDINALITY AS legacy(tag_name, position)
      WHERE btrim(legacy.tag_name) <> ''
      GROUP BY lower(btrim(legacy.tag_name))
    ) normalized
    JOIN tags catalog ON lower(catalog.name) = normalized.name;

    RETURN mapped_ids;
  END;
  $migration$;

  CREATE FUNCTION canonical_tag_names_from_ids(stored_ids uuid[]) RETURNS text[]
  LANGUAGE sql STABLE STRICT AS $migration$
    SELECT COALESCE(array_agg(catalog.name ORDER BY stored.position), '{}'::text[])
    FROM unnest(stored_ids) WITH ORDINALITY AS stored(id, position)
    JOIN tags catalog ON catalog.id = stored.id
  $migration$;

  CREATE FUNCTION merge_preserved_orphan_tag_ids(existing_ids uuid[], submitted_ids uuid[]) RETURNS uuid[]
  LANGUAGE plpgsql STABLE STRICT AS $migration$
  DECLARE
    merged_ids uuid[] := '{}'::uuid[];
    existing_id uuid;
    submitted_position integer := 1;
  BEGIN
    FOREACH existing_id IN ARRAY existing_ids LOOP
      IF EXISTS (SELECT 1 FROM tags catalog WHERE catalog.id = existing_id) THEN
        IF submitted_position <= cardinality(submitted_ids) THEN
          merged_ids := array_append(merged_ids, submitted_ids[submitted_position]);
          submitted_position := submitted_position + 1;
        END IF;
      ELSE
        merged_ids := array_append(merged_ids, existing_id);
      END IF;
    END LOOP;

    WHILE submitted_position <= cardinality(submitted_ids) LOOP
      merged_ids := array_append(merged_ids, submitted_ids[submitted_position]);
      submitted_position := submitted_position + 1;
    END LOOP;
    RETURN merged_ids;
  END;
  $migration$;

  CREATE FUNCTION bridge_article_legacy_tags() RETURNS trigger
  LANGUAGE plpgsql AS $migration$
  DECLARE
    mapped_ids uuid[];
  BEGIN
    IF TG_OP = 'INSERT' AND cardinality(NEW.tag_ids) > 0 AND cardinality(NEW.tags) = 0 THEN
      NEW.tags := canonical_tag_names_from_ids(NEW.tag_ids);
      RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE'
      AND NEW.tag_ids IS DISTINCT FROM OLD.tag_ids
      AND NEW.tags IS NOT DISTINCT FROM OLD.tags THEN
      NEW.tags := canonical_tag_names_from_ids(NEW.tag_ids);
      RETURN NEW;
    END IF;

    mapped_ids := canonical_tag_ids_from_legacy(NEW.tags);
    IF TG_OP = 'UPDATE' THEN
      mapped_ids := merge_preserved_orphan_tag_ids(OLD.tag_ids, mapped_ids);
    END IF;
    NEW.tag_ids := mapped_ids;
    NEW.tags := canonical_tag_names_from_ids(NEW.tag_ids);
    RETURN NEW;
  END;
  $migration$;

  CREATE FUNCTION bridge_revision_legacy_tags() RETURNS trigger
  LANGUAGE plpgsql AS $migration$
  DECLARE
    mapped_ids uuid[];
  BEGIN
    IF TG_OP = 'INSERT' AND cardinality(NEW.tag_ids) > 0 AND cardinality(NEW.tags) = 0 THEN
      NEW.tags := canonical_tag_names_from_ids(NEW.tag_ids);
      RETURN NEW;
    END IF;

    mapped_ids := canonical_tag_ids_from_legacy(NEW.tags);
    IF TG_OP = 'UPDATE' THEN
      NEW.tag_ids := merge_preserved_orphan_tag_ids(OLD.tag_ids, mapped_ids);
    ELSE
      SELECT merge_preserved_orphan_tag_ids(article.tag_ids, mapped_ids)
      INTO NEW.tag_ids
      FROM articles article
      WHERE article.id = NEW.article_id;
    END IF;
    NEW.tags := canonical_tag_names_from_ids(NEW.tag_ids);
    RETURN NEW;
  END;
  $migration$;

  CREATE FUNCTION bridge_catalog_legacy_tags() RETURNS trigger
  LANGUAGE plpgsql AS $migration$
  DECLARE
    affected_id uuid;
  BEGIN
    IF TG_OP = 'UPDATE' THEN
      IF NEW.name IS NOT DISTINCT FROM OLD.name THEN RETURN NEW; END IF;
      affected_id := NEW.id;
    ELSE
      affected_id := OLD.id;
    END IF;

    UPDATE articles
    SET tags = canonical_tag_names_from_ids(tag_ids)
    WHERE affected_id = ANY(tag_ids);

    UPDATE article_revisions
    SET tags = canonical_tag_names_from_ids(tag_ids)
    WHERE affected_id = ANY(tag_ids);

    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END;
  $migration$;

  CREATE TRIGGER articles_legacy_tags_bridge
  BEFORE INSERT OR UPDATE OF tags, tag_ids ON articles
  FOR EACH ROW EXECUTE FUNCTION bridge_article_legacy_tags();

  CREATE TRIGGER article_revisions_legacy_tags_bridge
  BEFORE INSERT OR UPDATE OF tags, tag_ids ON article_revisions
  FOR EACH ROW EXECUTE FUNCTION bridge_revision_legacy_tags();

  CREATE TRIGGER tags_legacy_name_update_bridge
  AFTER UPDATE OF name ON tags
  FOR EACH ROW EXECUTE FUNCTION bridge_catalog_legacy_tags();

  CREATE TRIGGER tags_legacy_delete_bridge
  AFTER DELETE ON tags
  FOR EACH ROW EXECUTE FUNCTION bridge_catalog_legacy_tags();
`;

export const agtVisibilitySql = `
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
`;

export const canonicalTagsContractSql = `
  DROP TRIGGER tags_legacy_name_update_bridge ON tags;
  DROP TRIGGER tags_legacy_delete_bridge ON tags;
  DROP TRIGGER articles_legacy_tags_bridge ON articles;
  DROP TRIGGER article_revisions_legacy_tags_bridge ON article_revisions;
  DROP FUNCTION bridge_catalog_legacy_tags();
  DROP FUNCTION bridge_article_legacy_tags();
  DROP FUNCTION bridge_revision_legacy_tags();
  DROP FUNCTION canonical_tag_names_from_ids(uuid[]);
  DROP FUNCTION canonical_tag_ids_from_legacy(text[]);
  DROP INDEX articles_tags_idx;
  ALTER TABLE articles DROP COLUMN tags;
  ALTER TABLE article_revisions DROP COLUMN tags;
`;

// Moves the super administrator out of local_users into the single-row admin
// table, adds Admin sessions, and renames member roles (Admin -> Moderator,
// Standard -> Editor). Bumping every session_version signs every member out.
// The super-admin row's credentials move to admin; its user_id stays in
// app_users so authorship and revision history are kept. The now-unused
// is_super_admin column is dropped by the explicit-only 014 contract.
export const adminAccountSql = `
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
`;

// Dashboard values for the backup limits. NULL means "use the default".
export const backupLimitSettingsSql = `
  ALTER TABLE application_settings
    ADD COLUMN backup_max_bytes bigint CHECK (backup_max_bytes > 0),
    ADD COLUMN backup_max_entries integer CHECK (backup_max_entries > 0),
    ADD COLUMN backup_max_uncompressed_bytes bigint CHECK (backup_max_uncompressed_bytes > 0);
`;

export const adminAccountContractSql = `
  DROP INDEX local_users_single_super_admin;
  ALTER TABLE local_users DROP COLUMN is_super_admin;
`;

// Dashboard settings as key/value rows (CFG-6). Values that differ from the
// 1.x defaults are copied; application_settings is dropped by 016.
export const settingsTableSql = `
  CREATE TABLE settings (
    key text PRIMARY KEY CHECK (key IN (
      'site.title', 'site.subtitle', 'site.supportUrl', 'articles.defaultVisibility',
      'access.allowPublicBrowsing', 'backup.maxZipBytes', 'backup.maxUncompressedBytes', 'backup.maxEntries'
    )),
    value jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  INSERT INTO settings (key, value, updated_at)
  SELECT entry.key, entry.value, source.updated_at
  FROM application_settings source
  CROSS JOIN LATERAL (VALUES
    ('site.title', CASE WHEN source.application_name <> 'AGT Knowledge Base' THEN to_jsonb(source.application_name) END),
    ('site.subtitle', CASE WHEN source.application_subtitle <> 'Field-tested guides, community procedures, and traveller intelligence.' THEN to_jsonb(source.application_subtitle) END),
    ('articles.defaultVisibility', CASE WHEN source.default_visibility <> '"Internal"'::jsonb THEN source.default_visibility END),
    ('access.allowPublicBrowsing', CASE WHEN NOT source.allow_public_browsing THEN 'false'::jsonb END),
    ('backup.maxZipBytes', to_jsonb(source.backup_max_bytes)),
    ('backup.maxUncompressedBytes', to_jsonb(source.backup_max_uncompressed_bytes)),
    ('backup.maxEntries', to_jsonb(source.backup_max_entries))
  ) AS entry (key, value)
  WHERE entry.value IS NOT NULL;
`;

export const dropApplicationSettingsSql = `
  DROP TABLE application_settings;
`;

// Password hashes in the AUTH-2 format, the AUTH-3 Admin username rule, the
// AUTH-8 sessions table and member cookie sessions.
export const authSessionsSql = `
  -- AUTH-2: 1.x hashes (scrypt$<salt base64url>$<hash base64url>, Node's default
  -- N=16384, r=8, p=1) become the six-field format with standard base64. The
  -- server rehashes them with the current profile on the next successful sign-in.
  UPDATE admin
  SET password_hash = 'scrypt$16384$8$1$'
    || translate(split_part(password_hash, '$', 2), '-_', '+/') || '==$'
    || translate(split_part(password_hash, '$', 3), '-_', '+/') || '=='
  WHERE password_hash ~ '^scrypt\\$[A-Za-z0-9_-]{22}\\$[A-Za-z0-9_-]{86}$';

  UPDATE local_users
  SET password_hash = 'scrypt$16384$8$1$'
    || translate(split_part(password_hash, '$', 2), '-_', '+/') || '==$'
    || translate(split_part(password_hash, '$', 3), '-_', '+/') || '=='
  WHERE password_hash ~ '^scrypt\\$[A-Za-z0-9_-]{22}\\$[A-Za-z0-9_-]{86}$';

  -- AUTH-3: the Admin username is stored as entered after trimming, 1-64 characters.
  ALTER TABLE admin
    DROP CONSTRAINT admin_username_check,
    ADD CONSTRAINT admin_username_check
      CHECK (char_length(username) BETWEEN 1 AND 64 AND username !~ '^\\s' AND username !~ '\\s$');

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
`;

export const migrations: Migration[] = [
  {
    id: '001_initial',
    sql: `
      CREATE EXTENSION IF NOT EXISTS pgcrypto;

      CREATE TABLE IF NOT EXISTS app_users (
        cognito_sub text PRIMARY KEY,
        display_name varchar(120) NOT NULL,
        email varchar(254),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        created_at timestamptz NOT NULL DEFAULT now()
      );

      CREATE TABLE IF NOT EXISTS articles (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title varchar(180) NOT NULL CHECK (char_length(title) >= 3),
        content text NOT NULL CHECK (char_length(content) BETWEEN 20 AND 250000),
        tags text[] NOT NULL DEFAULT '{}',
        is_protected boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        created_by text NOT NULL REFERENCES app_users(cognito_sub),
        modified_at timestamptz NOT NULL DEFAULT now(),
        modified_by text NOT NULL REFERENCES app_users(cognito_sub),
        version integer NOT NULL DEFAULT 1 CHECK (version > 0),
        search_vector tsvector GENERATED ALWAYS AS (
          setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
          setweight(to_tsvector('simple', coalesce(content, '')), 'B')
        ) STORED
      );

      CREATE INDEX IF NOT EXISTS articles_search_idx ON articles USING gin(search_vector);
      CREATE INDEX IF NOT EXISTS articles_tags_idx ON articles USING gin(tags);
      CREATE INDEX IF NOT EXISTS articles_modified_idx ON articles (modified_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS articles_created_idx ON articles (created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS articles_title_idx ON articles (lower(title), id);
    `,
  },
  {
    id: '002_article_revisions',
    sql: `
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
    `,
  },
  {
    id: '003_article_pinning',
    sql: `
      ALTER TABLE articles
        ADD COLUMN is_pinned boolean NOT NULL DEFAULT false;

      ALTER TABLE article_revisions
        ADD COLUMN is_pinned boolean NOT NULL DEFAULT false;

      CREATE INDEX articles_pinned_modified_idx
        ON articles (is_pinned DESC, modified_at DESC, id DESC);
    `,
  },
  {
    id: '004_article_visibility',
    sql: `
      ALTER TABLE articles
        ADD COLUMN visibility varchar(16) NOT NULL DEFAULT 'Internal'
        CHECK (visibility IN ('Public', 'Internal', 'Admin'));

      ALTER TABLE article_revisions
        ADD COLUMN visibility varchar(16) NOT NULL DEFAULT 'Internal'
        CHECK (visibility IN ('Public', 'Internal', 'Admin'));

      CREATE INDEX articles_visibility_modified_idx
        ON articles (visibility, modified_at DESC, id DESC);
    `,
  },
  {
    id: '005_article_verification',
    sql: `
      ALTER TABLE articles
        ADD COLUMN is_verified boolean NOT NULL DEFAULT false;

      ALTER TABLE article_revisions
        ADD COLUMN is_verified boolean NOT NULL DEFAULT false;
    `,
  },
  {
    id: '006_canonical_tags_expand',
    sql: canonicalTagsExpandSql,
  },
  {
    id: '007_canonical_tags_contract',
    sql: canonicalTagsContractSql,
    requiresExplicitTarget: true,
  },
  {
    id: '008_local_auth',
    sql: `
      CREATE TABLE local_users (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        username varchar(64) NOT NULL UNIQUE
          CHECK (username = lower(username) AND username ~ '^[a-z0-9_.-]{3,64}$'),
        password_hash text NOT NULL,
        display_name varchar(120) NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 120),
        email varchar(254) UNIQUE CHECK (email IS NULL OR email = lower(email)),
        role varchar(16) NOT NULL CHECK (role IN ('Admin', 'Standard')),
        is_active boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      );
    `,
  },
  {
    id: '009_admin',
    sql: `
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
    `,
  },
  {
    id: '010_agt_visibility',
    sql: agtVisibilitySql,
  },
  {
    // Renames the user key, which held Cognito subjects, to a provider-neutral
    // name. Foreign keys from articles and article_revisions follow the column.
    id: '011_rename_user_key',
    sql: `
      ALTER TABLE app_users RENAME COLUMN cognito_sub TO user_id;
    `,
  },
  {
    id: '012_admin_account',
    sql: adminAccountSql,
  },
  {
    id: '013_backup_limit_settings',
    sql: backupLimitSettingsSql,
  },
  {
    id: '014_admin_account_contract',
    sql: adminAccountContractSql,
    requiresExplicitTarget: true,
  },
  {
    id: '015_settings_table',
    sql: settingsTableSql,
  },
  {
    id: '016_drop_application_settings',
    sql: dropApplicationSettingsSql,
    requiresExplicitTarget: true,
  },
  {
    id: '017_auth_sessions',
    sql: authSessionsSql,
  },
];
