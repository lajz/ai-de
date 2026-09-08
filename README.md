# FDE Context Platform

A multi-tenant context layer for Forward Deployed Engineering organizations. It
ingests signal from meeting agents, docs, project trackers, and Slack — plus
meetings it captures itself — and builds a queryable graph of **stakeholders ↔
decisions ↔ commitments ↔ risks ↔ work items**, each record carrying
source-attributed evidence.

Architecture plan: `~/.claude/plans/linked-popping-rose.md`.

> The `@fde/*` package scope is a placeholder — rename once the product is named.

## Layout

```
apps/
  api/       NestJS — WorkOS auth + the request-scoped tenant/engagement seam
  workers/   Temporal workers
packages/
  core/    canonical domain model, provenance types, the Connector contract
  crypto/  key hierarchy (tenant CMK / engagement DEK), field-encryption codecs
  db/      Drizzle schema, Row-Level-Security policies, client + tenant helpers
  audit/   append-only access-log writer + tenant-facing query API
```

The remaining apps (`web`, `mcp`) and packages (`connectors`, `authz`, `llm`,
`identity`) land later in M1 — see the plan's build order.

## Prerequisites

- Node `>=22` (`.nvmrc` pins 22)
- pnpm 11 (`corepack enable`)
- Docker (local Postgres) or any Postgres 16 with `vector` + `pg_trgm`

## Setup

```bash
pnpm install
cp .env.example .env
docker compose up -d postgres        # PG_HOST_PORT=5433 if 5432 is taken

pnpm db:generate         # drizzle-kit: SQL from the schema (builds first)
pnpm db:bootstrap        # one-time: extensions + the app_rw role (superuser connection)
pnpm db:migrate          # apply pending migrations
pnpm db:harden           # FORCE RLS + grants (re-run after each migrate)
```

`db:bootstrap` / `db:harden` need `psql`; if it isn't installed, see
`packages/db/README.md` for the `docker exec` form.

## Common tasks

| Command          | What                                  |
| ---------------- | ------------------------------------- |
| `pnpm build`     | `tsc -b` across packages (via Turbo)  |
| `pnpm typecheck` | `tsc -b` (build doubles as typecheck) |
| `pnpm test`      | Vitest, against package source        |
| `pnpm lint`      | ESLint (flat config)                  |
| `pnpm format`    | Prettier write                        |
| `pnpm review`    | Advisory AI review of the branch diff |

## Review gate

- **Local:** `pnpm install` installs a `pre-push` hook (`.githooks/pre-push`) that
  blocks the push on `lint` / `typecheck` / `format:check` / `test` failures, then
  runs an advisory AI review (checks block; the AI review never does).
- **PRs:** `.github/workflows/review.yml` posts the AI findings as inline review
  comments, resolves them with a note once fixed, and approves when nothing is at
  or above `high`. Needs the `REVIEW_API_KEY` repo secret.

Add a `REVIEW_API_KEY` to `.env` to enable the local AI pass — see
[`tools/review/README.md`](tools/review/README.md).

## Security-relevant conventions

- **Every tenant-facing query goes through `withTenant(db, tenantId, fn)`** (from
  `@fde/db`) so Postgres RLS scopes it. Never issue a bare `db.select()` against a
  tenant table. `withTenant` also runs `SET LOCAL ROLE app_rw`, so RLS applies
  even in local dev where you connect as a superuser. A deployed app should
  connect as `app_rw` (or a login role that is a member of it — see
  `sql/bootstrap.sql`); a session that is neither superuser nor `app_rw` fails
  closed.
- Columns holding content bodies, quotes, and credential refs use the `encrypted`
  column type. On `main` it is a fail-closed shim; `@fde/crypto` (build step 4)
  routes it through the per-engagement DEK. Treat those values as opaque
  `Ciphertext`.
- `access_log` is append-only (enforced by grants in `db:harden`).
