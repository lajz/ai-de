# Build roadmap

The canonical build order and the near-term PR queue. Update this when a PR
lands or the plan changes — it's the thing to read after clearing context before
dispatching the next feature.

Full architecture rationale (tiers, key hierarchy, threat model, stack choices,
data model, connector strategy) lives in
[`docs/architecture.md`](./architecture.md).

---

## Where things stand

**Security spine — done** (PRs #1–#3, on `main`):

|                           |                                                                                                                                                                                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@fde/core`               | domain vocabulary — branded ids, enum tuples, retention rules (Slack → `reference-only`), provenance/graph types, `RawArtifact` / `CanonicalRecord` Zod schemas, the `Connector` interface, `charSpanSchema`                                                                                                |
| `@fde/db`                 | Drizzle schema (13 tables), per-tenant Postgres RLS (`withTenant` → `SET LOCAL ROLE app_rw` + `app.tenant_id`), `tenants` self-isolation by PK, fail-closed grants, composite `(engagement_id, id)` FKs between engagement-scoped rows, `pgvector` embeddings, append-only `access_log`, `encrypted` column |
| `@fde/crypto`             | AWS KMS → per-tenant CMK → per-engagement DEK; `EngagementCipher` over the AWS Encryption SDK; `AsyncLocalStorage` crypto context; `KmsKeyProvider` / `FakeKeyProvider`; `encryptRow` / `decryptRow` mappers                                                                                                |
| `@fde/db` ↔ `@fde/crypto` | `CRYPTO_COLUMNS` registry, `withEngagement()` (one DEK unwrap + `FOR SHARE` lock vs concurrent shred), `shredEngagement()` (drop `wrapped_dek`, one audit row, idempotent)                                                                                                                                  |
| `tools/review`            | pre-push gate + `.github/workflows/review.yml` (inline comments, resolve-on-fix, auto-approve when nothing ≥ high)                                                                                                                                                                                          |

**Verified against real infra:** RLS cross-tenant isolation + deny-by-default +
`access_log` append-only + `tenants` self-isolation; encrypt-at-rest + decrypt
round-trip; crypto-shred blocks access; composite-FK cross-engagement rejection;
`KmsKeyProvider` against LocalStack.

**Landed since the spine:** `@fde/audit` (#8), `apps/workers` +
`CaptureSession` (#6, #15), `@fde/llm` (#14), `apps/api` skeleton (#16),
**Langfuse redacted tracing + the extraction eval harness (#11)** — the `Tracer`
seam in `@fde/llm` (`LangfuseTracer` / `NoopTracer` / `FakeTracer`,
`createTracerFromEnv`, an `assertRedacted` boundary + a canary test), wired as a
structured layer over `onUsage` (`tracingUsageSink` + `traceExtraction`) into
`ExtractionPipeline` — redacted spans only (tokens / prompt version / latency /
cost / ids / coarse outcome / hashes, never content); and `@fde/eval` — a
hand-labelled fixture set, a precision/recall + key-phrase scorer, and a
committed-baseline no-regression gate (`pnpm --filter @fde/eval eval`, not part
of `pnpm test`) — and **`@fde/authz` (#10)** — SpiceDB schema (`AUTHZ_SCHEMA` +
`schema.zed`), the
`AuthzClient` seam (`SpiceDbAuthzClient` / `InMemoryAuthzClient` /
`createAuthzClientFromEnv`), and platform-role checks wired into `apps/api`
behind `AUTHZ_ENFORCE` (default off, layered on top of RLS). Source-ACL
mirroring stays deferred to M5 — the schema/wrapper leave additive hooks for it.

**`ExtractionPipeline` workflow (roadmap #8) — landed:** an encrypted transcript
`source` is chunked, run through Claude structured extraction (ZDR, bulk tier),
and written as `facts` + `evidence` (🔒 quote + char span, model spans verified
verbatim against the source) + `embeddings`, every row stamped with one
`extraction_run_id`; a durable timer then purges `raw_body` under
`derived-ephemeral-raw`. Ids-only payloads; all body handling inside one
activity. Redacted Langfuse tracing + the extraction eval gate (#11) are now
wired in. `captureSessionWorkflow` auto-triggers `extractionPipelineWorkflow` as
a detached (`parentClosePolicy: ABANDON`) child workflow once a body is
retained, keyed by `sourceId` so a capture retry can't double-start it.

**`apps/web` engagement view + single-engagement Q&A (roadmap #9) — landed:**
`apps/api` grew a testable `retrieval/` service and two engagement-scoped routes
— `GET /engagements/:id/facts` (decrypted facts + evidence citations to
`sources.url_permalink`) and `POST /engagements/:id/qa` (embed the question →
pgvector cosine KNN over `embeddings` → `canViewEngagement` gate **before** the
LLM → decrypt the surviving sources post-gate → answer from that context only,
via a new versioned `qa` prompt in `@fde/llm`). The raw drizzle reads live in
`@fde/db` (`selectEngagementFacts` / `selectNearestChunks` / …). Both routes log
`content_read` (and `/qa` also `retrieval`) in the request transaction; decrypted
content never reaches a log line. `filterCandidatesByAcl` is the identity seam
for M4 per-source ACL filtering. `apps/web` is a thin read-only Next.js App
Router app (engagement list → fact list → Ask panel) that proxies every API call
server-side with the caller's `fde_session` token.

---

## Next up — the M1 completion queue

Goal of M1: **one engagement, meeting capture → extracted decisions, end to end,
on the security spine.** Each row below is one PR / one dispatch. `≈` is rough
size. Dependencies in the last column.

| #      | PR                                                       | What                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | ≈   | Needs                       |
| ------ | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- | --------------------------- |
| 4      | **`@fde/audit`**                                         | typed `logAccess()` append-only writer; tenant-facing query surface (list access to engagement X, by actor/date/action); break-glass primitive — time-boxed grant, reason required, second-person approval, every step logged. Pure package.                                                                                                                                                                                                                                                                                               | S   | —                           |
| ~~5~~  | ~~**`apps/api` skeleton + WorkOS**~~ _(done)_            | NestJS app; WorkOS SSO + SCIM/Directory Sync behind a fake-able port; `TenantContextGuard` + `TenantContextInterceptor` (auth → 401 pre-DB, then `withTenant` / `withEngagement`, exposed via an `AsyncLocalStorage` `RequestContext`); `/healthz` `/me` `/engagements` `/engagements/:id/audit`; OpenAPI → `apps/api/openapi.json`; zod-validated config.                                                                                                                                                                                 | M   | #4                          |
| 6      | **Temporal + `apps/workers` skeleton**                   | Temporal Cloud client + worker bootstrap; one trivial workflow+activity end to end; the `cipher`-param convention for activities (no `AsyncLocalStorage` across the worker boundary); payloads carry ids, never bodies.                                                                                                                                                                                                                                                                                                                    | M   | —                           |
| 7      | **`CaptureSession` workflow**                            | schedule a Recall.ai bot → meeting → transcript webhook → store as a `source` (`🔒 raw_body` inline, or S3 + `raw_object_key`) through `withEngagement`; retention-policy aware.                                                                                                                                                                                                                                                                                                                                                           | M   | #6, Recall.ai account + DPA |
| ~~8~~  | ~~**`@fde/llm` + `ExtractionPipeline`**~~ _(done)_       | Claude router (ZDR, `claude-opus-5` default / `claude-sonnet-5` bulk), versioned extraction prompts, pluggable embedding client (Voyage first). Workflow: chunk transcript → structured extraction → `facts` + `evidence` (🔒 quote + `char_span`) + `embeddings`, all stamped `extraction_run_id`; purge raw under `derived-ephemeral-raw`.                                                                                                                                                                                               | L   | #7                          |
| ~~9~~  | ~~**`apps/web` engagement view**~~ _(done)_              | Next.js; engagement list; fact list with source citations (permalinks); single-engagement Q&A (pgvector retrieval → authz gate → decrypt post-gate). Read-only. Landed as `@fde/db` read helpers + `apps/api/src/retrieval/` + `GET :id/facts` / `POST :id/qa` + a versioned `qa` prompt in `@fde/llm` + a thin `apps/web` App Router app.                                                                                                                                                                                                 | M   | #5, #8                      |
| ~~10~~ | ~~**`@fde/authz` (SpiceDB) — platform roles**~~ _(done)_ | SpiceDB schema + typed check/write wrappers; platform-role checks in the read path behind `AUTHZ_ENFORCE`. Source-ACL mirroring is deferred to M5 (Slack).                                                                                                                                                                                                                                                                                                                                                                                 | M   | #5                          |
| ~~11~~ | ~~**Langfuse + eval harness**~~ _(done)_                 | redacted tracing in `@fde/llm` (`Tracer` seam, `assertRedacted` boundary, `tracingUsageSink` + `traceExtraction` over `onUsage`, wired into `ExtractionPipeline`); `@fde/eval` — hand-labelled fixtures + precision/recall + key-phrase scorer + committed-baseline no-regression gate; `.github/workflows/eval.yml` (non-required, manual gate absent a CI provider).                                                                                                                                                                     | S   | #8                          |
| ~~12~~ | ~~**M1 e2e test harness**~~ _(done)_                     | `docker-compose.e2e.yml` (pgvector + Temporal dev server); a recorded-meeting fixture driven through `captureSessionWorkflow` (which auto-starts `extractionPipelineWorkflow`) on the security spine; asserts field-encryption at rest, the crypto-shred boundary, tenant-isolation RLS, resolvable citations + the raw-body purge. `e2e/` vitest project (`pnpm e2e`, not in `pnpm test`); `.github/workflows/e2e.yml` (non-required). Deterministic extraction stand-in — quality stays with #11. See [`docs/testing.md`](./testing.md). | M   | #7, #8, #9                  |

**Suggested order:** #4 and #6 in parallel → #5 → #7 → #8 → (#9, #10, #11 in
parallel). #9–#12 are all in, and the capture → extraction auto-trigger is
wired — the M1 code queue is clear. M1 is done when the
[M1 e2e check](./architecture.md#verification) passes in staging.

**Parallel track (not code):** SOC 2 controls; sub-processor DPAs + zero-retention
riders (Anthropic ZDR, Voyage, Recall.ai); public sub-processor list; security
whitepaper for sales.

---

## After M1

- **M2 — Granola connector** (`Connector` interface, direct `grn_` REST client, same `ExtractionPipeline`) + identity resolution v1 (`@fde/identity`: deterministic matches → fuzzy + human-review queue).
  - **Connector + generic sync — landed:** `@fde/connectors` (`GranolaClient` seam — `HttpGranolaClient` real `grn_` bearer REST / `FakeGranolaClient` deterministic / `loadGranolaClient` on `GRANOLA_API_KEY`; `GranolaConnector implements Connector` — cursor-poll `backfill`/`incremental` with per-page checkpoints, workspace-membership `resolveAcl`, pure `normalize` → meeting/document + participant `Person` entities + `externalRefs`; `handleWebhook` → `[]` seam), a `ConnectorRegistry` factory, and the reusable **`ConnectorSync`** Temporal workflow (`apps/workers` — ids-only payload; per-artifact dedupe → `resolveAcl` → encrypted `acl_snapshots` → encrypted `sources` row through `withEngagementActivity`; `connector_sync_state` cursor table in `@fde/db`; starts `extractionPipelineWorkflow` as an ABANDON child per new transcript). Identity resolution (`@fde/identity`) is still the parallel PR — `normalize` only emits `externalRefs`.
- **M3 — Linear via self-hosted Nango**: pull work items, link `(decision)-[implemented_by]->(workitem)`, write back a comment/link. **Kick off Slack Marketplace review here** (~7-week lead).
- **M4 — per-user authz-filtered retrieval + regulated-tier controls**: SpiceDB source-ACL mirroring + retrieval as the asking user; BYOK/CMEK (cross-account KMS grant, XKS) + `CryptoShred` Temporal workflow (DEK destruction + async ciphertext purge + audit); self-hosted embedding model option; `retentionPolicy` + region pin enforced end to end; Google Docs via Nango (`drive.file` scope, defers CASA); stakeholder + relationship-graph UI.
- **M5 — Slack**: Marketplace app + Data Access API; `reference-only` (summary + permalink + ≤N-char quote, no body storage); ACL re-checked at query time.
- **M6 — dedicated tier + public extensibility**: T1 Terraform workspace per tenant (self-hosted Temporal/SpiceDB/Nango, dedicated Aurora + S3, region pin), proven with one design partner; inbound ingestion API + MCP server GA + connector SDK; Jira / Asana / Notion / MS Graph as demand dictates.

---

## Open decisions (low-risk to revisit)

1. Extraction model default — `claude-opus-5` vs `claude-sonnet-5` for bulk: run `pnpm --filter @fde/eval eval` against each and compare (the #11 harness + `--update-baseline` flow).
2. AuthZ engine — SpiceDB (recommended) vs OpenFGA: pick at #10; wrapper keeps it swappable.
3. Postgres host — Aurora (recommended) vs Neon: can start on Neon, migrate before the first enterprise pilot / T1.
4. Retrieval store — stay on `pgvector` until a measured limit.
5. Self-hosted embedding model — which (BGE, E5, other): benchmark at M4.
6. Frontend hosting — Vercel vs ECS.
