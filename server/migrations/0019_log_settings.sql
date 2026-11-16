-- LOG-16: the log retention settings are dashboard settings too (CFG-6).
ALTER TABLE settings DROP CONSTRAINT settings_key_check;
ALTER TABLE settings ADD CONSTRAINT settings_key_check CHECK (key IN (
  'site.title', 'site.subtitle', 'site.supportUrl', 'articles.defaultVisibility',
  'access.allowPublicBrowsing', 'backup.maxZipBytes', 'backup.maxUncompressedBytes', 'backup.maxEntries',
  'logs.serverRetentionDays', 'logs.serverMaxEntries', 'logs.auditRetentionDays', 'logs.auditMaxEntries'
));
