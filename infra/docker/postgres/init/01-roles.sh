#!/bin/sh
# Creates the Astra database roles and databases on first start of the local PostgreSQL container.
# astra_owner owns schemas and runs migrations. astra_app is the runtime role: no superuser,
# no BYPASSRLS, so row-level security always applies to it.
set -eu

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<SQL
CREATE ROLE astra_owner LOGIN PASSWORD '${ASTRA_DB_OWNER_PASSWORD}';
CREATE ROLE astra_app LOGIN PASSWORD '${ASTRA_DB_APP_PASSWORD}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
ALTER ROLE astra_app SET statement_timeout = '30s';
ALTER ROLE astra_app SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE astra_app SET transaction_timeout = '60s';
CREATE DATABASE astra OWNER astra_owner;
CREATE DATABASE astra_test OWNER astra_owner;
REVOKE ALL ON DATABASE astra FROM PUBLIC;
REVOKE ALL ON DATABASE astra_test FROM PUBLIC;
GRANT CONNECT ON DATABASE astra TO astra_app;
GRANT CONNECT ON DATABASE astra_test TO astra_app;
CREATE ROLE keycloak LOGIN PASSWORD '${KEYCLOAK_DB_PASSWORD}';
CREATE DATABASE keycloak OWNER keycloak;
SQL
