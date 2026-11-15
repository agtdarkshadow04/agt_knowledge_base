-- One-time upgrade of a 1.x database to the 2.0 database role (DATA-11, DEP-3).
--
-- 1.x connected as the bootstrap superuser. 2.0 connects as the non-superuser
-- role agt_knowledge_base and refuses to start as a superuser. Run this once, as
-- the superuser, in the app's database, before starting 2.0. It is idempotent.
-- With Docker Compose (see README, Upgrading to 2.0):
--
--   set -a && . ./.env && set +a
--   docker compose up -d postgres
--   docker compose exec -T postgres psql -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" \
--     -d "${POSTGRES_DB:-agt_knowledge_base}" -v app_password="$AGT_KNOWLEDGE_BASE_DB_PASSWORD" \
--     < deploy/upgrade-database-role.sql

\set ON_ERROR_STOP on

-- The role, with the password from .env (AGT_KNOWLEDGE_BASE_DB_PASSWORD).
SELECT 'CREATE ROLE agt_knowledge_base LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE'
WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agt_knowledge_base') \gexec
ALTER ROLE agt_knowledge_base WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE PASSWORD :'app_password';

-- The role owns the database, the public schema and everything in it.
SELECT format('ALTER DATABASE %I OWNER TO agt_knowledge_base', current_database()) \gexec
ALTER SCHEMA public OWNER TO agt_knowledge_base;
SELECT format('ALTER TABLE public.%I OWNER TO agt_knowledge_base', tablename)
FROM pg_tables WHERE schemaname = 'public' \gexec
SELECT format('ALTER FUNCTION %s OWNER TO agt_knowledge_base', oid::regprocedure)
FROM pg_proc WHERE pronamespace = 'public'::regnamespace
  AND NOT EXISTS (SELECT 1 FROM pg_depend WHERE objid = pg_proc.oid AND deptype = 'e') \gexec

-- The superuser owns pgcrypto, so the role could not drop it. Nothing needs it
-- once the ID defaults are gone (DATA-6; migration 0018 drops them too).
ALTER TABLE IF EXISTS public.articles ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.tags ALTER COLUMN id DROP DEFAULT;
ALTER TABLE IF EXISTS public.local_users ALTER COLUMN id DROP DEFAULT;
DROP EXTENSION IF EXISTS pgcrypto;

-- The restore preview database (BAK-3), owned by the role.
SELECT 'CREATE DATABASE agt_knowledge_base_preview OWNER agt_knowledge_base'
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'agt_knowledge_base_preview') \gexec
