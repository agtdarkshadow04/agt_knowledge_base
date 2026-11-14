BEGIN;

-- Contract step of 015: the settings now live in settings.
DROP TABLE application_settings;

COMMIT;
