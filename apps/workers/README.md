# @fde/workers

Temporal worker process — the durable-workflow foundation. Runs workflows +
activities registered against a task queue; workflows schedule syncs,
backfills, capture, extraction, ACL refresh, crypto-shred (see
[`docs/architecture.md`](../../docs/architecture.md)).

## Connection

`connection.ts` — `loadTemporalConnectionConfig()` reads the environment:

- **Temporal Cloud** (T0 default): `TEMPORAL_ADDRESS` + `TEMPORAL_NAMESPACE`,
  plus either mTLS (`TEMPORAL_CLIENT_CERT` + `TEMPORAL_CLIENT_KEY`, PEM) or an
  API key (`TEMPORAL_API_KEY`).
- **Local dev**: nothing set, or `TEMPORAL_ADDRESS` pointing at localhost —
  `temporal server start-dev` (default `localhost:7233`), no TLS.

A half-supplied credential pair, or a non-local address with no credentials at
all, throws immediately instead of failing at connect time with a vaguer
error. `connectWorkerConnection` / `connectClient` turn the resolved config
into a `NativeConnection` (worker) or `Connection` (client, e.g. for
`apps/api` to start/signal workflows from).

## Task queues

`task-queue.ts` — `taskQueueFor(tenantId)` → `fde-{tenantId}`. T0 (pooled) is
one shared Temporal namespace with per-tenant task queues, so a `Worker` can be
scaled or drained per tenant without affecting others. T1 (dedicated) gets its
own namespace, so `DEFAULT_TASK_QUEUE` (`fde-default`) is enough there — it's
also what this package's own `pingWorkflow` smoke test and the local dev
worker use until a real tenant-scoped workflow lands.

## Worker bootstrap

`worker.ts` — builds a `Worker` (`@temporalio/worker`), registers the
workflows bundle (`workflows/index.ts`) and the activity map
(`activities/index.ts`), and runs until `SIGINT`/`SIGTERM`, at which point it
calls `worker.shutdown()` and waits for `worker.run()` to return before
closing the DB pool and the Temporal connection — in-flight activities get a
chance to finish.

Temporal's built-in workflow bundler (webpack + `swc-loader`, shipped inside
`@temporalio/worker`) transpiles TypeScript itself, so `workflowsPath` points
straight at `src/workflows/index.ts` — no separate build step needed for the
workflow bundle in dev or prod.

```bash
pnpm --filter @fde/workers dev     # tsx, local Temporal dev server
pnpm --filter @fde/workers build   # tsc -b
pnpm --filter @fde/workers start   # node dist/worker.js
```

Requires `DATABASE_URL`. `FDE_FAKE_KMS=true` swaps in `FakeKeyProvider`
(no AWS) for local dev; never set it outside dev/test.

## The ping loop

`workflows/ping.ts` + `activities/ping.ts` — the trivial end-to-end proof:
`pingWorkflow({ nonce })` calls `pingActivity`, which returns
`{ nonce, at: <iso> }`. `nonce` is an opaque id-like token, never a body —
`workflows/ping.test.ts` exercises it against `@temporalio/testing`'s
time-skipping `TestWorkflowEnvironment` (no real Temporal cluster needed, so
it runs in CI).

## The crypto-across-the-boundary convention

`@fde/crypto`'s request-path convention (`runWithCrypto` / `getCipher`) is
`AsyncLocalStorage`-based, set once by a NestJS interceptor per request. That
doesn't survive Temporal's workflow → activity boundary: a workflow's decision
to touch 🔒 data and the activity that does it are separate RPCs, potentially
executed on a different worker process, so there's no shared async execution
chain for an `AsyncLocalStorage` store to live on.

The convention here instead:

1. A workflow's input carries **ids only** — `{ tenantId, engagementId, ... }`,
   never a cipher, DEK, or body content (Temporal persists workflow inputs in
   its event history).
2. The activity that needs to touch 🔒 data resolves those ids to a live
   cipher itself, via `activities/engagement-context.ts`'s
   `withEngagementActivity(db, keyProvider, ref, fn)` — the activity-side
   counterpart to `@fde/db`'s `withEngagement`, same shape, but it hands the
   cipher to `fn` as an **explicit argument** (`ctx.cipher`) instead of
   leaving it on `AsyncLocalStorage` for `getCipher()` to find. One KMS unwrap
   per call; the cipher is never returned from the activity or passed to
   another one — an activity that also needs it calls
   `withEngagementActivity` again.
3. Activities never call `getCipher()` and never import `AsyncLocalStorage`
   themselves (`activities/no-async-local-storage.test.ts` checks this
   statically). `withEngagementActivity` is the one sanctioned, documented
   exception, and even it only touches the store synchronously inside the
   call frame `withEngagement` just opened — see the comment in
   `engagement-context.ts`.

`activities/describe-engagement.ts` + `workflows/describe-engagement.ts` are a
worked example: `describeEngagementWorkflow({ tenantId, engagementId })` →
`describeEngagementActivity` → `withEngagementActivity` → a live cipher, used
and discarded inside that one activity call.

## Tests

```bash
pnpm --filter @fde/workers test
```

- `workflows/ping.test.ts` — the ping loop against `TestWorkflowEnvironment`'s
  time-skipping server (downloaded once, cached; no external Temporal).
- `connection.test.ts`, `task-queue.test.ts` — pure config/naming unit tests.
- `activities/no-async-local-storage.test.ts` — static check that no activity
  file (besides the documented `engagement-context.ts` exception) imports
  `AsyncLocalStorage` or references `getCipher`.
- `activities/engagement-context.test.ts` — integration test for
  `withEngagementActivity` against a real, migrated + hardened database.
  Skipped unless `DATABASE_URL` is set (same convention as
  `packages/db/src/engagement.test.ts`):
  ```bash
  docker compose up -d postgres && pnpm db:bootstrap && pnpm db:migrate && pnpm db:harden
  DATABASE_URL=postgres://postgres:postgres@localhost:5433/fde_dev pnpm --filter @fde/workers test
  ```
