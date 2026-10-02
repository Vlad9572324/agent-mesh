#!/usr/bin/env bash
# Sourced once by the official PostgreSQL entrypoint, only for empty PGDATA.
# The admin password is loaded by POSTGRES_PASSWORD_FILE; PGPASSWORD is supplied
# internally by that entrypoint. Never pass credentials in psql arguments.
(
    set -euo pipefail
    agent_mesh_password=$(< /run/agent-mesh/app-password)
    if [[ ! $agent_mesh_password =~ ^[0-9a-f]{64}$ ]]; then
        printf '%s\n' 'Invalid private application password file' >&2
        exit 1
    fi
    # A generated hex password cannot inject SQL. Disable statement/error SQL
    # logging for this session so a setup failure cannot log the password.
    PGOPTIONS='-c log_statement=none -c log_min_error_statement=panic' \
      psql --no-psqlrc --no-password --quiet --set ON_ERROR_STOP=1 \
        --username postgres --dbname postgres <<SQL
CREATE ROLE agent_mesh LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '$agent_mesh_password';
CREATE DATABASE agent_mesh OWNER agent_mesh;
REVOKE ALL ON DATABASE agent_mesh FROM PUBLIC;
SQL
    unset agent_mesh_password
)
