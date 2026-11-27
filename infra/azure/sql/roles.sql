-- Run once per environment, before the first migration, by the database administrator (the bootstrap job does it).
-- astra_owner owns the schemas and runs migrations; astra_app is the runtime role, to which row-level security always
-- applies. Mirrors infra/docker/postgres/init/01-roles.sh. Safe to run again: it also sets the passwords.
SELECT format('CREATE ROLE %I LOGIN', r) FROM unnest(ARRAY['astra_owner', 'astra_app']) AS r
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
ALTER ROLE astra_owner PASSWORD :'owner_password';
ALTER ROLE astra_app PASSWORD :'app_password';
ALTER ROLE astra_app SET statement_timeout = '30s';
ALTER ROLE astra_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE astra_app SET transaction_timeout = '60s';
-- The administrator must belong to the owner role to hand the database to it.
GRANT astra_owner TO current_user;
ALTER DATABASE astra OWNER TO astra_owner;
REVOKE ALL ON DATABASE astra FROM PUBLIC;
GRANT CONNECT ON DATABASE astra TO astra_app;
-- Only where Keycloak is the identity provider (development): its own role and database, closed to everyone else.
\if :{?keycloak_password}
SELECT 'CREATE ROLE keycloak LOGIN' WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'keycloak') \gexec
ALTER ROLE keycloak PASSWORD :'keycloak_password';
GRANT keycloak TO current_user;
ALTER DATABASE keycloak OWNER TO keycloak;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
\connect keycloak
GRANT USAGE, CREATE ON SCHEMA public TO keycloak;
\connect postgres
\endif

-- A database created through Azure, unlike one created in SQL, does not give its owner the public schema. The
-- extensions the migrations name are created here, by the administrator.
\connect astra
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS btree_gist;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
GRANT USAGE, CREATE ON SCHEMA public TO astra_owner;
-- Shown in the job's log.
SELECT nspname, pg_get_userbyid(nspowner) AS owner, has_schema_privilege('astra_owner', oid, 'CREATE') AS owner_can_create
  FROM pg_namespace WHERE nspname = 'public';
