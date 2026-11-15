#!/bin/sh
# Creates the app's non-superuser role and its databases (DATA-11, DEP-3).
# The postgres image runs this once, when its data volume is empty, as the
# bootstrap superuser. An existing 1.x database needs
# deploy/upgrade-database-role.sql instead.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v app_password="$AGT_KNOWLEDGE_BASE_DB_PASSWORD" <<'SQL'
SELECT 'CREATE ROLE agt_knowledge_base LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agt_knowledge_base') \gexec
ALTER ROLE agt_knowledge_base WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';
SELECT 'CREATE DATABASE agt_knowledge_base OWNER agt_knowledge_base'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'agt_knowledge_base') \gexec
SELECT 'CREATE DATABASE agt_knowledge_base_preview OWNER agt_knowledge_base'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'agt_knowledge_base_preview') \gexec
ALTER DATABASE agt_knowledge_base OWNER TO agt_knowledge_base;
ALTER DATABASE agt_knowledge_base_preview OWNER TO agt_knowledge_base;
SQL
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname agt_knowledge_base \
  -c 'ALTER SCHEMA public OWNER TO agt_knowledge_base'
