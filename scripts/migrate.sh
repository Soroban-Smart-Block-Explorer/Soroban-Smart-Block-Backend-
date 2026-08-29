#!/usr/bin/env sh
# scripts/migrate.sh
#
# Runs Prisma database migrations as a one-shot init container.
# This script is executed by the dedicated `migrate-*` services defined in
# docker-compose.yml and exits 0 on success, non-zero on failure.
#
# Design intent (#901):
#   Application containers (api-*, indexer-*) MUST NOT run migrations at
#   startup.  Migrations are executed here, in an isolated job that completes
#   before any application container starts, via the compose
#   `depends_on: { migrate-*: { condition: service_completed_successfully } }`
#   guard.  This prevents the following failure modes:
#
#     1. Race condition: multiple replicas each attempting `migrate deploy`
#        concurrently on the same database.
#     2. Startup failure: the application process exiting with a non-zero code
#        (which restarts the entire container) when a migration fails rather
#        than surfacing a clear, isolated error in the migration job.
#     3. Permission coupling: the application container needs DB credentials
#        with migration-level privileges only during the migration window, not
#        throughout its lifetime.
#
# Usage (executed automatically by docker-compose.yml):
#   DATABASE_URL=<connection-string> sh scripts/migrate.sh
#
# Manual invocation for debugging:
#   docker compose run --rm migrate-testnet
set -eu

: "${DATABASE_URL:?DATABASE_URL must be set}"

echo "[migrate] Starting Prisma migration for DATABASE_URL host: $(echo "$DATABASE_URL" | sed 's|.*@||;s|/.*||')"
echo "[migrate] Timestamp: $(date -u +%Y-%m-%dT%H:%M:%SZ)"

npx prisma migrate deploy

echo "[migrate] Migrations applied successfully."
