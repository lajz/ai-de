# Build roadmap

The canonical build order and the near-term PR queue. Update this when a PR
lands or the plan changes — it's the thing to read after clearing context before
dispatching the next feature.

Full architecture rationale (tiers, key hierarchy, threat model, stack choices,
data model, connector strategy) lives in
[`docs/architecture.md`](./architecture.md).

---

## Where things stand

**M1 progress (2026-09-08):** the security spine (#1–#3) plus #4 `@fde/audit`,
#5 `apps/api` + WorkOS, #6 `apps/workers` (Temporal skeleton), #7 `CaptureSession`,
and the `@fde/llm` package half of #8 are all merged to `main`.

- **In flight:** #8 `ExtractionPipeline` workflow (branch `lajz/fde-extraction`),
  #10 `@fde/authz` SpiceDB (branch `lajz/fde-authz`) — dispatched in parallel.
- **Blocked on #8:** #9 `apps/web`, #11 Langfuse + eval.

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

---

## Next up — the M1 completion queue

Goal of M1: **one engagement, meeting capture → extracted decisions, end to end,
on the security spine.** Each row below is one PR / one dispatch. `≈` is rough
size. Dependencies in the last column.

| #     | PR                                                                          | What                                                                                                                                                                                                                                                                                                                                                                                                             | ≈   | Needs                       |
| ----- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | --------------------------- |
| ~~4~~ | ~~**`@fde/audit`**~~ _(done)_                                               | typed `logAccess()` append-only writer; tenant-facing query surface (list access to engagement X, by actor/date/action); break-glass primitive — time-boxed grant, reason required, second-person approval, every step logged. Pure package.                                                                                                                                                                     | S   | —                           |
| ~~5~~ | ~~**`apps/api` skeleton + WorkOS**~~ _(done)_                               | NestJS app; WorkOS SSO + SCIM/Directory Sync behind a fake-able port; `TenantContextGuard` + `TenantContextInterceptor` (auth → 401 pre-DB, then `withTenant` / `withEngagement`, exposed via an `AsyncLocalStorage` `RequestContext`); `/healthz` `/me` `/engagements` `/engagements/:id/audit`; OpenAPI → `apps/api/openapi.json`; zod-validated config.                                                       | M   | #4                          |
| ~~6~~ | ~~**Temporal + `apps/workers` skeleton**~~ _(done)_                         | Temporal Cloud client + worker bootstrap; one trivial workflow+activity end to end; the `cipher`-param convention for activities (no `AsyncLocalStorage` across the worker boundary); payloads carry ids, never bodies.                                                                                                                                                                                          | M   | —                           |
| ~~7~~ | ~~**`CaptureSession` workflow**~~ _(done)_                                  | schedule a Recall.ai bot → meeting → transcript webhook → store as a `source` (`🔒 raw_body` inline, or S3 + `raw_object_key`) through `withEngagement`; retention-policy aware.                                                                                                                                                                                                                                 | M   | #6, Recall.ai account + DPA |
| 8     | **`@fde/llm` + `ExtractionPipeline`**                                       | `@fde/llm` **done** (PR #14): Claude router (ZDR, `claude-opus-5` / `claude-sonnet-5` bulk), versioned extraction prompts, pluggable embedding client. **In flight (`lajz/fde-extraction`):** the workflow — chunk transcript → structured extraction → `facts` + `evidence` (🔒 quote + `char_span`) + `embeddings`, all stamped `extraction_run_id`; durable-timer purge of raw under `derived-ephemeral-raw`. | L   | #7                          |
| 9     | **`apps/web` engagement view**                                              | Next.js; engagement list; fact list with source citations (permalinks); single-engagement Q&A (pgvector retrieval → authz gate → decrypt post-gate). Read-only.                                                                                                                                                                                                                                                  | M   | #5, #8                      |
| 10    | **`@fde/authz` (SpiceDB) — platform roles** _(in flight, `lajz/fde-authz`)_ | SpiceDB schema + typed check/write wrappers (`AuthzClient` seam, in-memory + gRPC impls); platform-role checks in the `apps/api` read path behind `AUTHZ_ENFORCE`. Source-ACL mirroring is deferred to M5 (Slack).                                                                                                                                                                                               | M   | #5                          |
| 11    | **Langfuse + eval harness**                                                 | redacted tracing in `@fde/llm` (token counts / prompt version / hashes — never content); first hand-labelled extraction eval set; no-regression gate on prompt changes.                                                                                                                                                                                                                                          | S   | #8                          |

**Suggested order:** #4 and #6 in parallel → #5 → #7 → #8 → (#9, #10, #11 in
parallel). M1 is done when the [M1 e2e check](./architecture.md#verification)
passes in staging. **Now:** #8-workflow and #10 running in parallel; #9 and #11
dispatch once #8 lands.

**Parallel track (not code):** SOC 2 controls; sub-processor DPAs + zero-retention
riders (Anthropic ZDR, Voyage, Recall.ai); public sub-processor list; security
whitepaper for sales.

---

## After M1

- **M2 — Granola connector** (`Connector` interface, direct `grn_` REST client, same `ExtractionPipeline`) + identity resolution v1 (`@fde/identity`: deterministic matches → fuzzy + human-review queue).
- **M3 — Linear via self-hosted Nango**: pull work items, link `(decision)-[implemented_by]->(workitem)`, write back a comment/link. **Kick off Slack Marketplace review here** (~7-week lead).
- **M4 — per-user authz-filtered retrieval + regulated-tier controls**: SpiceDB source-ACL mirroring + retrieval as the asking user; BYOK/CMEK (cross-account KMS grant, XKS) + `CryptoShred` Temporal workflow (DEK destruction + async ciphertext purge + audit); self-hosted embedding model option; `retentionPolicy` + region pin enforced end to end; Google Docs via Nango (`drive.file` scope, defers CASA); stakeholder + relationship-graph UI.
- **M5 — Slack**: Marketplace app + Data Access API; `reference-only` (summary + permalink + ≤N-char quote, no body storage); ACL re-checked at query time.
- **M6 — dedicated tier + public extensibility**: T1 Terraform workspace per tenant (self-hosted Temporal/SpiceDB/Nango, dedicated Aurora + S3, region pin), proven with one design partner; inbound ingestion API + MCP server GA + connector SDK; Jira / Asana / Notion / MS Graph as demand dictates.

---

## Open decisions (low-risk to revisit)

1. Extraction model default — `claude-opus-5` vs `claude-sonnet-5` for bulk: decide on the #11 eval set.
2. AuthZ engine — SpiceDB (recommended) vs OpenFGA: pick at #10; wrapper keeps it swappable.
3. Postgres host — Aurora (recommended) vs Neon: can start on Neon, migrate before the first enterprise pilot / T1.
4. Retrieval store — stay on `pgvector` until a measured limit.
5. Self-hosted embedding model — which (BGE, E5, other): benchmark at M4.
6. Frontend hosting — Vercel vs ECS.
