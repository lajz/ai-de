#!/usr/bin/env sh
# Bootstrap + migrate + harden the e2e database. Run once after the compose
# stack is up, before `pnpm e2e`.
#
#   DATABASE_URL=postgres://postgres:postgres@localhost:5442/fde_e2e e2e/scripts/db-setup.sh
#
# Deliberately does NOT source the repo `.env` (the root `pnpm db:*` scripts do,
# which would point this at the dev database). It uses only DATABASE_URL from the
# environment. Needs `psql` on PATH — same as `pnpm db:bootstrap` / `db:harden`.
set -eu

: "${DATABASE_URL:?set DATABASE_URL to the e2e database, e.g. postgres://postgres:postgres@localhost:5442/fde_e2e}"

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
cd "$root"

echo "e2e db: bootstrap"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/sql/bootstrap.sql

echo "e2e db: migrate"
pnpm exec tsx packages/db/src/migrate.ts

echo "e2e db: harden"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f packages/db/sql/harden-rls.sql

echo "e2e db: ready"
