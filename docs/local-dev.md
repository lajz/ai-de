# Local dev

One command — `tilt up` — brings up every backing service and the three apps
(`@fde/api`, `@fde/web`, `@fde/workers`) with a dashboard, aggregated logs,
dependency ordering, and hot-reload.

Tilt drives `docker-compose` for the infra and supervises the apps as local
`pnpm dev` processes. It does **not** build images and does **not** use
Kubernetes — production packaging is still undecided.

## Prerequisites

- **Docker** — [OrbStack](https://orbstack.dev) is the recommended macOS runtime
  (faster, lighter than Docker Desktop). Docker Desktop or colima also work.
- **Tilt** — `brew install tilt-dev/tap/tilt` or
  `curl -fsSL https://raw.githubusercontent.com/tilt-dev/tilt/master/scripts/install.sh | bash`
- **pnpm 11** — `corepack enable`, then `pnpm install`
- **Node ≥ 22** (`.nvmrc` pins 22)
- `psql` on your PATH — `db:bootstrap` / `db:harden` shell out to it
  (`packages/db/README.md` has a `docker exec` fallback if you'd rather not
  install it)

```bash
pnpm install
cp .env.example .env      # defaults already match the compose stack
```

Set `FDE_FAKE_KMS=true` in `.env` unless you have AWS credentials — it swaps the
in-memory `KeyProvider` in for `api` and `workers` (never use it outside
dev/test). External API keys (Recall.ai, Granola, Anthropic, Voyage) are all
optional: the apps fall back to deterministic fakes without them.

## `tilt up`

```bash
pnpm dev          # → tilt up
# or: tilt up
```

The dashboard is at <http://localhost:10350>. Two groups:

### `infra` (docker-compose)

| Resource     | What                                                                                                                                                                  | Ports              |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `postgres`   | pgvector/pg16, database `fde_dev`, named volume `pgdata`                                                                                                              | 5432               |
| `temporal`   | `temporal server start-dev`, SQLite on named volume `temporaldata`; UI included                                                                                       | 7233 gRPC, 8233 UI |
| `spicedb`    | `authzed/spicedb serve`, in-memory, preshared key `dev`                                                                                                               | 50051              |
| `setup`      | one-shot: `db:bootstrap` → `db:migrate` → `db:harden` → `@fde/authz schema:push`. Runs once on `tilt up`; re-run from the dashboard (▶) after pulling new migrations. | —                  |
| `localstack` | KMS for `@fde/crypto` — **off** unless `tilt up -- aws`                                                                                                               | 4566               |
| `redis`      | not wired into app code yet (M3) — **off** unless `tilt up -- redis`                                                                                                  | 6379               |

### `apps` (local processes)

| Resource  | Command                                    | Waits on            | Ready when              |
| --------- | ------------------------------------------ | ------------------- | ----------------------- |
| `api`     | `pnpm --filter @fde/api dev` (`tsx watch`) | `setup`, `temporal` | `GET :3000/healthz` 200 |
| `workers` | `pnpm --filter @fde/workers dev` (`tsx`)   | `setup`, `temporal` | process up              |
| `web`     | `pnpm --filter @fde/web dev` (`next dev`)  | `api`               | TCP :3001               |

`tsx watch` / `next dev` do their own file watching; Tilt just supervises,
restarts on crash, and collects logs.

### Optional profiles

```bash
tilt up -- aws          # + localstack
tilt up -- redis        # + redis
tilt up -- aws redis    # both
```

## Common tasks

**Stop everything** (containers stop, named volumes kept):

```bash
pnpm dev:down     # → tilt down
```

**Reset the database** — drop the Postgres volume and let `setup` rebuild:

```bash
tilt down
docker volume rm fde-tilt_pgdata
tilt up           # `setup` runs bootstrap + migrate + harden again
```

Same shape for Temporal history: `docker volume rm fde-tilt_temporaldata`.

**Just the infra, no apps** (e.g. to run an app from your editor/debugger):

```bash
docker compose up -d              # postgres + temporal + spicedb
docker compose --profile aws --profile redis up -d   # + optional ones
pnpm --filter @fde/api dev        # then run whichever app yourself
```

**Point the API at the real SpiceDB** instead of the in-memory client:
uncomment the `SPICEDB_*` block in `.env` (values already match the container),
then restart `api` from the dashboard. `setup` pushes the schema on every run.

## Port already in use?

Every host port is a `${VAR:-default}` in `docker-compose.yml`. Set the
override in `.env` (`PG_HOST_PORT`, `TEMPORAL_HOST_PORT`, `TEMPORAL_UI_PORT`,
`SPICEDB_HOST_PORT`, `REDIS_HOST_PORT`, `LOCALSTACK_PORT`) and update the
matching URL/address (`DATABASE_URL`, `TEMPORAL_ADDRESS`, …) to the new port.

## Relationship to the e2e stack

`docker-compose.e2e.yml` is separate and unchanged — its own project name, its
own ports (5442 / 7233), an ephemeral database. `pnpm e2e` still uses it; see
[`docs/testing.md`](./testing.md).
