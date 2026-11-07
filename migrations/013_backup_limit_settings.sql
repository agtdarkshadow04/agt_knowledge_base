BEGIN;

-- Dashboard values for the backup limits; NULL means the default applies.
ALTER TABLE application_settings
  ADD COLUMN backup_max_bytes bigint CHECK (backup_max_bytes > 0),
  ADD COLUMN backup_max_entries integer CHECK (backup_max_entries > 0),
  ADD COLUMN backup_max_uncompressed_bytes bigint CHECK (backup_max_uncompressed_bytes > 0);

COMMIT;
