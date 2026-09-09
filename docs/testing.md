# Testing

Three tiers, by what infra they need.

| Tier          | Command                             | Needs                                          | In `pnpm test`?           |
| ------------- | ----------------------------------- | ---------------------------------------------- | ------------------------- |
| Unit          | `pnpm test`                         | nothing                                        | yes                       |
| Integration   | `pnpm test` with `DATABASE_URL` set | a migrated + hardened Postgres                 | yes (skipped otherwise)   |
| M1 end-to-end | `pnpm e2e`                          | `docker-compose.e2e.yml` (Postgres + Temporal) | **no** — separate project |

Unit + integration follow the `describe.skipIf(!process.env.DATABASE_URL)`
convention — the suite is green with no database, and exercises the real schema
when `DATABASE_URL` points at one (`docker compose up -d postgres && pnpm
db:bootstrap && pnpm db:migrate && pnpm db:harden`).

## The M1 end-to-end test

`e2e/m1-pipeline.e2e.test.ts` is the automated form of the
[M1 e2e check](./architecture.md#verification). One recorded-meeting fixture
runs through:

- `captureSessionWorkflow` → the transcript lands as an **encrypted** `sources`
  row (raw bytes are ciphertext; undecryptable with the wrong DEK);
- `extractionPipelineWorkflow` → `facts` + `evidence` (🔒 quote + resolvable
  `char_span`) + `embeddings` (dim 1024), every row stamped with one
  `extraction_run_id`; then the `derived-ephemeral-raw` durable purge timer nulls
  `sources.raw_body`;
- the read path (`@fde/db` retrieval helpers, post-gate decrypt) returns the
  facts with citations whose spans slice back to the exact transcript quote.

and asserts, along the way:

- **field encryption at rest** — a raw SQL read of `facts.body` / `evidence.quote`
  / `sources.raw_body` is ciphertext, never the plaintext phrases;
- **the crypto-shred boundary** — after `shredEngagement`, `withEngagement` fails
  closed, the 🔒 fields are permanently undecryptable, and `access_log` has the
  `crypto_shred` row;
- **tenant isolation** — tenant B cannot read tenant A's `facts` (Postgres RLS).

Extraction here uses a **deterministic stand-in** built from the fixture's
expected-extraction spec, not a real LLM call — extraction _quality_ is gated by
`@fde/eval` / `eval.yml`. The full HTTP read path (WorkOS + SpiceDB gate) is
covered by `apps/api/src/retrieval/retrieval.e2e.test.ts`.

### Run it locally

```bash
pnpm e2e:stack:up          # Postgres on :5442, Temporal dev server on :7233
DATABASE_URL=postgres://postgres:postgres@localhost:5442/fde_e2e pnpm e2e:db
DATABASE_URL=postgres://postgres:postgres@localhost:5442/fde_e2e \
  TEMPORAL_ADDRESS=localhost:7233 \
  pnpm e2e
pnpm e2e:stack:down        # stop + wipe (the DB has no volume — every run is clean)
```

`pnpm e2e:db` needs `psql` on PATH (same as `pnpm db:bootstrap`). Override the
host ports with `E2E_PG_PORT` / `E2E_TEMPORAL_PORT` if 5442 / 7233 are taken
(keep `DATABASE_URL` / `TEMPORAL_ADDRESS` in sync).

**Temporal without the container:** if `TEMPORAL_ADDRESS` is unset the test spins
up an in-process `TestWorkflowEnvironment` (the same `temporal server start-dev`
binary, downloaded once by `@temporalio/testing`), so with just a Postgres you
can run:

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5442/fde_e2e pnpm e2e
```

CI still runs against the compose Temporal (`TEMPORAL_ADDRESS` set).

The e2e is skipped unless `DATABASE_URL` is set, so it never runs as part of
`pnpm test`. CI runs it in `.github/workflows/e2e.yml` (non-required for now).
