BEGIN;

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

INSERT INTO schema_migrations (id) VALUES ('006_canonical_tags_expand');

COMMIT;
