# @fde/db

Drizzle schema, Row-Level-Security policies, the Postgres client, and the
`withTenant` helper.

## Schema

| File                   | Tables                                                                   |
| ---------------------- | ------------------------------------------------------------------------ |
| `schema/tenancy.ts`    | `tenants`, `users`, `engagements`                                        |
| `schema/sources.ts`    | `sources`, `acl_snapshots`                                               |
| `schema/graph.ts`      | `entities`, `relationships` (polymorphic edges)                          |
| `schema/facts.ts`      | `facts`, `evidence`, `extraction_runs`                                   |
| `schema/embeddings.ts` | `embeddings` (pgvector)                                                  |
| `schema/identities.ts` | `identities`                                                             |
| `schema/audit.ts`      | `access_log` (append-only)                                               |
| `schema/tables.ts`     | `TENANT_SCOPED_TABLES` registry — keep in sync with `sql/harden-rls.sql` |

## Row-Level Security

Every tenant-scoped table has a `<table>_tenant_isolation` policy:
`tenant_id = current_setting('app.tenant_id', true)::uuid`. The app connects as
`app_rw`; `sql/harden-rls.sql` adds `FORCE ROW LEVEL SECURITY` so the policy also
binds the table owner.

**All tenant-facing queries must go through `withTenant(db, tenantId, fn)`**,
which opens a transaction and sets `app.tenant_id` for its duration.

## Encrypted columns

`body`, `quote`, `raw_body`, `connection_secret_ref` use the `encrypted` column
type (`bytea`). Today it is a transport shim; build step 4 (`@fde/crypto`) routes
it through the per-engagement DEK. The DB never sees plaintext.

## Local workflow

```bash
pnpm db:generate           # SQL migrations from the schema (builds first)
pnpm db:bootstrap          # extensions + app_rw role (needs a superuser connection)
pnpm db:migrate            # apply migrations (run from repo root)
pnpm db:harden             # FORCE RLS + grants — re-run after every migrate
```

`db:bootstrap` / `db:harden` shell out to `psql`. Without it installed, pipe the
files into the container:

```bash
CID=$(docker compose ps -q postgres)
docker exec -i "$CID" psql -U postgres -d fde_dev -v ON_ERROR_STOP=1 < packages/db/sql/bootstrap.sql
docker exec -i "$CID" psql -U postgres -d fde_dev -v ON_ERROR_STOP=1 < packages/db/sql/harden-rls.sql
```

Verified end to end: RLS blocks cross-tenant reads _and_ writes (`WITH CHECK`), a
query with no `app.tenant_id` returns zero rows (never errors), and `access_log`
rejects `UPDATE`/`DELETE` for `app_rw`.
