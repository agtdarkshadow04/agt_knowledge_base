BEGIN;

-- Dashboard settings become key/value rows in settings (CFG-6). Values that
-- differ from the 1.x defaults are copied; 016 drops application_settings.
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

COMMIT;
