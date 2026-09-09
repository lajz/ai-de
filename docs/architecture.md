# Architecture

The FDE Context Platform — design rationale, stack, data model, and the
mechanics of provenance + permission enforcement. Build order and the live PR
queue are in [`ROADMAP.md`](./ROADMAP.md).

## The product

A multi-tenant context layer for Forward Deployed Engineering organizations. It
ingests signal from the tools an FDE org already runs — meeting agents, docs,
project trackers, Slack — plus meetings it captures itself, and turns that
stream into a queryable graph of **stakeholders ↔ decisions ↔ commitments ↔
risks ↔ work items**, each record carrying source-attributed evidence. FDE orgs
can later wire in their own tooling through the same connector abstraction.

**The wedge** is the cross-source **provenance graph with query-time permission
enforcement** — the part that Slack's 2025 API terms make legally and
architecturally hard. Closest others: Stipulate (Slack-only, early), Granola
(expanding a "company context layer" from meeting capture), Rocketlane (PS/
onboarding ops).

**The trust problem is the product problem.** FDE orgs work _inside their
customers'_ environments, so the platform transitively holds highly sensitive
third-party data (transcripts describing a customer's systems, customer Slack,
roadmap decisions). An FDE org can only adopt this if it can make _its own
customers_ a credible promise about isolation, encryption, and access control.
Security is a first-class M1 deliverable, not a later concern.

## Hard constraints

- **Multi-tenant SaaS**, pooled by default, with a **dedicated-data-plane tier**
  as a config path (not a rewrite). **No customer-cloud (BYOC) deployment** in
  scope — but the control-plane / data-plane seam is preserved.
- **Assume regulated content from day one** (healthcare / defense / financial):
  per-engagement customer-managed keys with crypto-shred, application-layer
  field encryption of content bodies, zero standing employee access with audited
  break-glass, HIPAA-ready controls before certification.
- **Provenance is constraint #1.** Every derived fact links to evidence; every
  evidence row carries its origin (system, container, author, occurred-at) and
  the ACL that governed it.
- **Slack (May 29 2025 terms):** no bulk export, no persistent copies / archives
  / indexes, no LLM use of Slack data. Slack is **reference-only** (summary +
  permalink + minimal quote) via the Data Access / Real-Time Search API, ACL
  re-checked **at query time**. Requires Slack Marketplace approval (~7-week
  review — start early).
- **Own meeting capture** via Recall.ai (bot-based), so the product does not
  depend on the customer using Granola / Otter / etc.
- **Google Docs / M365** access is gated by platform-compliance programs (Google
  CASA for `drive.readonly`; MS admin consent). Start with narrow scopes
  (`drive.file`) to defer CASA.

## Locked decisions

- **TypeScript everywhere** (Node 22 LTS). Go reserved for a future
  perf-critical service; Python only for a data-science need.
- **NestJS** API (module-per-connector). **Next.js** (App Router) web.
- **Temporal** as the workflow engine — Temporal Cloud for T0, self-hostable for
  T1. Payloads carry ids, never bodies.
- **PostgreSQL** (Aurora) + `pgvector` + `pg_trgm`; no Aurora-only features.
- **Drizzle** ORM — explicit control over RLS session vars and the encryption
  boundary.
- Tenancy: `tenant_id` on every row + **Postgres RLS**; `withTenant` sets
  `SET LOCAL ROLE app_rw` + `app.tenant_id` per transaction.
- **Engagement** is the unit of cryptographic isolation: per-tenant CMK →
  per-engagement DEK (envelope), BYOK/CMEK via cross-account KMS grant or XKS.
- LLM: **Claude via the Anthropic API with Zero Data Retention** — default
  `claude-opus-5`, `claude-sonnet-5` as the cost-tuned bulk tier. ZDR rules out
  `claude-fable-5`. Embeddings pluggable via `@fde/llm` — Voyage AI (T0) /
  self-hosted BGE-E5 (regulated + T1).
- **WorkOS** for SSO + SCIM. **SpiceDB** for authz (Zanzibar model; OpenFGA the
  lower-cost equivalent, kept behind a wrapper). **Nango self-hosted** for
  connector OAuth (token custody). **Langfuse** for LLM eval — self-hosted or
  redacted traces only.
- Extensibility (public ingestion API / MCP / connector SDK): design the
  internal abstraction now, expose publicly at M6.

## Deployment & data security

### Tiers (a ladder, one codebase)

| Tier               | Who                                | Data plane                                                                                                                                | Delta from T0                                               |
| ------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **T0 — Pooled**    | design partners, SMB, most         | shared Aurora + RLS, shared Temporal (per-tenant task queues), shared workers with tenant-scoped execution, shared S3 (per-tenant prefix) | —                                                           |
| **T1 — Dedicated** | large / regulated (enterprise SKU) | dedicated Aurora cluster, workers, S3 bucket, Temporal namespace; optional region pin                                                     | config flag + Terraform workspace; same image, schema, code |

Both tiers carry the full key hierarchy, field encryption, and access controls.
The design rule that keeps T1 a flag: the data plane (api + Temporal workers +
Postgres + object store + SpiceDB + Nango) is a self-contained deployable unit —
no managed-only DB features, storage behind an interface, everything
self-hostable.

### Encryption & key hierarchy

```
AWS KMS root
  └─ per-tenant CMK            (tenants.cmk_key_ref)      ── or a customer BYOK key
       └─ per-engagement DEK   (engagements.wrapped_dek)  ── 32-byte AES key, envelope-wrapped
            └─ field ciphertext (facts.body, evidence.quote, sources.raw_body, …)
```

**BYOK / CMEK + crypto-shred.** A tenant or engagement may supply its own KMS
key (cross-account grant / XKS). Dropping the wrapped DEK (`wrapped_dek → NULL`)
renders that engagement's transcripts, message/doc bodies, `evidence.quote`,
`facts.body`, and stored raw artifacts **permanently unreadable immediately** —
no deletion job to trust, no backups to chase. The core enterprise promise.

**Field-level (application-layer) encryption**, per-engagement DEK, before
Postgres or S3: raw artifact payloads (when retained), transcript / message /
doc bodies, `evidence.quote`, `facts.body`, connector OAuth tokens, the source
text behind every embedding. Disk encryption (Aurora, S3 SSE-KMS) sits
underneath. Net effect: a stolen DB credential or a dump is per-engagement
ciphertext.

**Design tension:** field encryption breaks native Postgres FTS on those
columns. Resolution — semantic retrieval works (embeddings computed
pre-encryption; the `pgvector` column is disk-encrypted + tenant/engagement
scoped and never leaves the data plane); lexical/metadata search runs over
deliberately non-sensitive fields (titles, entity names, participants, dates,
fact `summary`). Free-text search _inside encrypted bodies_ is semantic-only.

**Inference privacy.** Claude with ZDR. Embeddings: Voyage (no-retention DPA) for
T0, self-hosted for regulated/T1 so body text never leaves the data plane.
Recall.ai: DPA + minimum retention (pull, encrypt into our store, rely on their
auto-purge). No plaintext content in logs, ever.

**Data residency.** Per-tenant (optionally per-engagement) region pin — `us`,
`eu` — covering storage, compute, inference. Cross-region opt-in only.

### Data minimization — the retention policy

Every connector carries a `retentionPolicy`, overridable per engagement:

| Policy                  | Behaviour                                                                                                                                                                                                 | Default for                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `reference-only`        | canonical entities + derived facts + evidence pointers (permalink + ≤N-char quote) + ACL snapshot. **No body storage.** Content fetched at query time via the linking user's own OAuth, ACL-checked live. | Slack (always); opt-in elsewhere                       |
| `derived-ephemeral-raw` | raw pulled for the extraction pass, field-encrypted, deleted after the `extraction_run` completes + a short reprocessing window                                                                           | regulated engagements                                  |
| `full-retention`        | raw stored (field-encrypted) for the engagement's retention period                                                                                                                                        | low-sensitivity engagements wanting reprocessing/audit |

### Access control — zero standing access

- **No employee has standing access to tenant content.** Production content
  access requires **break-glass**: time-boxed, reason-required, second-person
  approval, every action written to an append-only, tenant-visible audit log.
- Internal support/ops tooling operates on **metadata only** — job status,
  counts, error classes, never bodies.
- The FDE org's own users' access is SpiceDB-gated and written to the same audit
  log the end customer can be shown.
- WorkOS SCIM deprovisioning revokes access, sessions, and tokens immediately.
- Backups are encrypted with the per-engagement keys (crypto-shred reaches
  them); restore is itself a break-glass, audited event.

### Sub-processor posture

Public sub-processor list, signed DPAs + zero-retention riders, annual security
review, region-honouring required. **Nango self-hosted** (not Cloud) — tokens
are crown-jewel access. **Langfuse: redacted traces only** (token counts, prompt
version, latency, hashes — never raw content). **Temporal Cloud** for T0 only;
T1 → self-hosted. **SpiceDB** via Authzed Cloud for T0, self-host for T1.

### Threat model

| Threat                                | Primary mitigation                                                                     |
| ------------------------------------- | -------------------------------------------------------------------------------------- |
| Cross-tenant leak                     | RLS + per-engagement field encryption → a full dump is per-engagement ciphertext       |
| Rogue employee                        | zero standing access + break-glass + tenant-visible audit log; metadata-only tooling   |
| Compromised DB credential / rogue DBA | field-level encryption; keys in KMS, not the DB                                        |
| Stolen connector OAuth token          | tokens field-encrypted + vaulted; revocable per connection                             |
| Compromised sub-processor             | ZDR / no-retention riders; self-host the sensitive ones; redacted traces               |
| Malicious tenant user                 | SpiceDB checks mirror source ACLs; retrieval authz-filtered before the LLM             |
| Prompt injection via ingested content | ingested text is data, never instructions; pipeline extraction never drives tool calls |
| Customer offboards / demands deletion | crypto-shred the engagement DEK → immediate, verifiable                                |

### Compliance roadmap

SOC 2 controls from M1 (audit logging, access reviews, change/vuln/vendor
management). SOC 2 Type II ~6 months in, then ISO 27001 and HIPAA (BAA-ready).
Annual third-party pen test. FedRAMP out of scope; the dedicated tier + region
model is the starting point if that market materializes.

## Stack summary

| Layer                                    | Choice                                                                                     | Notes                                                                      |
| ---------------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| Language                                 | TypeScript (Node 22 LTS)                                                                   | Go for a future perf-critical service only                                 |
| Monorepo                                 | pnpm workspaces + Turborepo                                                                |                                                                            |
| API                                      | NestJS                                                                                     | module-per-connector; DI for isolated connector tests                      |
| Frontend                                 | Next.js (App Router)                                                                       | Vercel to start, movable to ECS                                            |
| Web ↔ API                                | OpenAPI-generated client                                                                   |                                                                            |
| Workflows                                | Temporal — Cloud (T0) / self-hostable (T1)                                                 | syncs, backfills, capture, extraction, ACL refresh, crypto-shred           |
| System of record                         | PostgreSQL / Aurora                                                                        | `pgvector`, `pg_trgm`; no Aurora-only features                             |
| Tenancy                                  | `tenant_id` on every row + Postgres RLS (`SET LOCAL ROLE app_rw` + `app.tenant_id` per tx) |                                                                            |
| Crypto unit                              | engagement — per-tenant CMK → per-engagement DEK; BYOK via cross-account KMS grant / XKS   |                                                                            |
| Field encryption                         | app-layer, per-engagement DEK, on all content bodies + tokens + embedding source text      |                                                                            |
| ORM                                      | Drizzle                                                                                    |                                                                            |
| Object storage                           | S3, per-tenant prefix (T0) / dedicated bucket (T1), SSE-KMS + app-layer encryption         |                                                                            |
| Cache / rate-limit / short-TTL ACL cache | Redis (ElastiCache)                                                                        | no content in cache                                                        |
| Retrieval                                | `pgvector` (HNSW) + metadata search over non-encrypted fields                              | behind a `Retriever` interface                                             |
| AuthN                                    | WorkOS (SAML SSO + SCIM + org mgmt)                                                        |                                                                            |
| AuthZ                                    | SpiceDB — Authzed Cloud (T0) / self-host (T1)                                              | OpenFGA the alternative, behind a wrapper                                  |
| Connector infra                          | Nango, self-hosted — OAuth / refresh / rate-limit / pagination / webhooks                  |                                                                            |
| Meeting capture                          | Recall.ai direct + DPA + min retention                                                     | ~$0.50/hr rec + $0.15/hr transcription                                     |
| Granola                                  | direct thin client — `grn_` REST + optional MCP                                            | read-only                                                                  |
| LLM                                      | Claude via `@anthropic-ai/sdk` + ZDR — `claude-opus-5` default, `claude-sonnet-5` bulk     | `@fde/llm` router logs `{model, prompt_version, tokens, cost}`, no content |
| Embeddings                               | pluggable — Voyage AI (T0) / self-hosted BGE-E5 (regulated + T1)                           |                                                                            |
| LLM eval                                 | Langfuse — self-hosted or redacted traces only                                             |                                                                            |
| Infra                                    | AWS, Terraform (workspace per T1 tenant), ECS Fargate                                      |                                                                            |
| Secrets                                  | AWS Secrets Manager + KMS; connector tokens field-encrypted                                |                                                                            |
| Observability                            | OpenTelemetry → Grafana Cloud (or Datadog); Sentry (scrubbed)                              |                                                                            |

## Repo layout

```
apps/
  api/         NestJS — HTTP API, webhook receivers, auth, admin, break-glass
  web/         Next.js frontend
  workers/     Temporal workers (ConnectorSync, CaptureSession, ExtractionPipeline, ACLRefresh, CryptoShred)
  mcp/         MCP server — outward-facing; built, not GA until M6
packages/
  core/        domain model, canonical entity schema, provenance types, RawArtifact, retentionPolicy   [built]
  crypto/      key hierarchy (tenant CMK / engagement DEK), envelope ops, field-encryption codecs       [built]
  db/          Drizzle schema + migrations + RLS policies + encrypted-column types                       [built]
  connectors/  Connector interface + built-in implementations (on Nango or direct clients)
  authz/       SpiceDB schema + typed check/write wrappers
  llm/         model router (ZDR), extraction prompts (versioned), embedding client, redacted Langfuse tracer
  eval/        extraction eval harness — hand-labelled fixtures, precision/recall scorer, no-regression gate (dev-only)
  identity/    cross-system person/org identity resolution
  audit/       append-only audit-log writer + tenant-facing query API
tools/
  review/      AI PR review — pre-push gate + GitHub Action sink                                          [built]
infra/         Terraform (base + per-T1-tenant workspaces)
```

## Core data model (Postgres)

All tables carry `tenant_id`; RLS enforces isolation. Columns marked 🔒 are
application-layer field-encrypted with the per-engagement DEK (via the
`encrypted` column type + the `encryptRow` / `decryptRow` mappers, keyed by
`CRYPTO_COLUMNS`).

- **`tenants`** — the top-level customer account. No `tenant_id` (it _is_ the
  tenant); scoped by its own PK via `tenants_self_isolation`.
- **`engagements`** — `{ id, tenant_id, end_customer_name, region_pin,
retention_policy, wrapped_dek (NULL ⇒ shredded), byok_key_arn?, status
(active|closed|shredded) }`. The crypto + residency + lifecycle boundary.
- **`sources`** — one row per ingested artifact: `{ id, tenant_id, engagement_id,
connector, external_id, kind (transcript|message|doc|issue|comment),
url_permalink, workspace_ref, container_ref, author_ref, occurred_at,
ingested_at, content_hash, raw_object_key?, 🔒raw_body?, retention_policy,
acl_snapshot_id? }`. Dedupe on `(engagement_id, connector, external_id,
content_hash)`.
- **`acl_snapshots`** — `{ id, tenant_id, engagement_id, source_ref,
🔒principal_rules, captured_at, ttl_seconds, refresh_state }`; also projected
  into SpiceDB.
- **`entities`** — canonical nodes (`person`, `organization`, `work_item`,
  `document`, `meeting`), each with `external_refs[]` (cleartext, for identity
  resolution and dedup). `display_name` cleartext; 🔒`attributes`, 🔒`body`.
- **`facts`** — `{ id, tenant_id, engagement_id, type
(decision|commitment|risk|question|action_item|status_change), summary,
🔒body, status, confidence, occurred_at, extraction_run_id? }`. `summary`
  intentionally cleartext + terse (list views, lexical search); detail in
  🔒`body`.
- **`evidence`** — M:N join `{ id, tenant_id, engagement_id, fact_id, source_id,
🔒quote, char_start?, char_end?, relation (supports|contradicts),
extraction_run_id? }`. `engagement_id` denormalized so crypto-shred can
  enumerate without a join; composite `(engagement_id, id)` FKs to `facts` /
  `sources` / `extraction_runs` keep a row from ever referencing another
  engagement's row.
- **`relationships`** — polymorphic edges `{ tenant_id, engagement_id, from_kind
(entity|fact), from_id, predicate, to_kind, to_id, source_id? }`, e.g.
  `(stakeholder)-[owns]->(decision)`, `(decision)-[implemented_by]->(workitem)`.
  No FK on the endpoints (polymorphic).
- **`embeddings`** — `{ id, tenant_id, engagement_id, source_id, chunk_ref,
model, embedding vector(1024) }`. Vector computed pre-encryption; column
  protected by disk encryption + tenant/engagement scoping; never leaves the
  data plane.
- **`extraction_runs`** — `{ id, tenant_id, engagement_id, model, prompt_version,
input_source_ids[], cost_usd, created_at }` — lineage, no content.
- **`identities`** — `{ tenant_id, user_id, connector, external_account_id,
scopes, 🔒connection_secret_ref }`. Not engagement-scoped (credential reused
  across engagements).
- **`access_log`** — append-only (grants in `harden-rls.sql` revoke UPDATE/
  DELETE). Every content read, the resolving authz decision, every break-glass
  action. Tenant-queryable via `@fde/audit`.

**The graph lives in Postgres, not a graph DB.** Traversals are shallow (2–3
hops), per-tenant volumes modest — recursive CTEs + `relationships` cover it.

## Provenance & permission enforcement (the core mechanic)

1. **Ingest** → `RawArtifact` (via `Connector.backfill` / `.incremental` /
   `.handleWebhook`) → `Connector.resolveAcl` → `AclSnapshot` →
   `Connector.normalize` → canonical entities. Raw body stored (🔒) only if
   `retentionPolicy` permits.
2. **Extract** (Temporal `ExtractionPipeline`): chunk → Claude structured-output
   extraction (ZDR) → `facts` + `evidence` (🔒 quotes + `char_span`) +
   embeddings. Every row stamped with `extraction_run_id`. Under
   `derived-ephemeral-raw` the raw body is purged when the run completes.
3. **Project ACLs into SpiceDB**: `slack_channel:C123#member@user:U9`,
   `engagement:acme#viewer@user:U9`, etc.
4. **Read path**: every API read and RAG retrieval resolves through
   `authz.check(user, view, fact)` → platform-role check **AND**, for each
   evidence source, the source-ACL check. Candidate sets are authz-filtered
   **before** the LLM. Decryption of 🔒 fields happens _after_ the authz gate, in
   the request context, with the per-engagement DEK. Citations link to
   `sources.url_permalink`.
5. **Slack specifics**: `reference-only`; ACL re-checked live (or ≤5-min TTL) at
   query time; never served from a stale index. `ACLRefresh` re-snapshots
   non-Slack sources on a schedule.

**Prompt-injection posture**: all ingested content is untrusted; extraction
prompts treat source text as data; pipeline extraction never drives tool calls.

## Connector strategy

One internal interface, three transports behind it.

```ts
interface Connector {
  id: string;
  authKind: 'nango-oauth' | 'bearer' | 'mcp-oauth' | 'inbound-push';
  retentionPolicy: RetentionPolicy;
  backfill(ctx): AsyncIterable<RawArtifact>; // resumable via Temporal
  incremental(ctx, cursor): AsyncIterable<RawArtifact>;
  handleWebhook(req): RawArtifact[];
  resolveAcl(artifact): Promise<AclSnapshot>;
  normalize(raw: RawArtifact): CanonicalEntity[];
}
```

- **Nango-backed** (self-hosted): Jira, Linear, Asana, Notion, Google Drive/Docs,
  Slack, MS Graph.
- **Direct**: Recall.ai (capture), Granola (`grn_` REST + optional MCP).
- **Custom (GA at M6+)**: customers implement the same contract via (a) a config
  - field-mapping for a REST/GraphQL/webhook source pushing to the inbound
    ingestion API, and later (b) sandboxed connector code. The MCP server lets
    customer agents read and write context.

## Identity resolution

The same person is `jane@acme.com` (Google), `jsmith` (Slack), `Jane Smith`
(Jira). `@fde/identity`: deterministic matches first (email, SSO subject), then
fuzzy (name + org) above a confidence threshold, with a human-review queue. All
`external_refs` accumulate on the `Person` entity.

## Verification

- **M1 e2e**: run a recorded meeting through Recall.ai in a staging tenant;
  assert the transcript lands encrypted (raw bytes unreadable without the DEK),
  `ExtractionPipeline` completes, `facts` rows exist with `evidence` linking to
  `sources` with correct `char_span` quotes and working permalinks, the UI
  renders citations.
- **Field encryption**: direct SQL read of `facts.body` / `evidence.quote` /
  `sources.raw_body` returns ciphertext; values decrypt only through the app
  path with the engagement DEK.
- **Crypto-shred**: run `CryptoShred` on a test engagement; assert every 🔒
  field is permanently undecryptable (backups included) and an `access_log`
  entry records it.
- **Tenant + engagement isolation**: tenant A cannot read tenant B's `facts` via
  API or retrieval; a user scoped to engagement X cannot retrieve engagement Y's
  facts within the same tenant.
- **Permission enforcement**: SpiceDB test — a user without `slack_channel`
  membership cannot retrieve a fact whose only evidence is from that channel;
  losing membership removes access within the TTL window.
- **Break-glass**: content access without an approved grant is denied and
  logged; a granted, time-boxed access appears in the tenant-visible audit log
  and expires on schedule.
- **No content egress**: Langfuse traces, logs, metrics, and Temporal payloads
  contain no decrypted bodies (CI scan against a seeded canary string).
- **Extraction quality**: Langfuse eval set of hand-labelled transcripts;
  precision/recall on decision & commitment extraction per prompt version; gate
  prompt changes on no-regression.
- **Connector contract**: conformance suite every `Connector` must pass
  (backfill resumability, cursor correctness, ACL snapshot shape, canonical
  normalization, retention-policy adherence).
- **Backfill durability**: kill a worker mid-backfill; Temporal resumes from the
  last cursor with no duplicate `sources`.
- **T1 packaging (M6)**: stand up a dedicated data plane via Terraform in a clean
  account; run the full M1–M5 e2e against it; confirm zero shared data-plane
  resources with T0.

## `@fde/crypto` decisions (locked)

- **Envelope: AWS Encryption SDK for JS** (`@aws-crypto/client-node`) — data-key
  caching, key commitment, multi-keyring for BYOK, encryption context.
- **Crypto-shred latency: request-scoped DEK cache only** — no cross-request
  TTL; keeps "revoke your key and we cannot read your data" absolute.
- **v1 encryption boundary:** `facts.body`, `evidence.quote`, `sources.raw_body`,
  `identities.connection_secret_ref`, `acl_snapshots.principal_rules`,
  `entities.attributes`, `entities.body`. Cleartext: display names,
  `external_refs`, permalinks, container/author refs, all of `extraction_runs`.
- **BYOK: cross-account KMS grant only** for now; the `KeyProvider` interface
  leaves room for an XKS-backed CMK as a later config change.
- **Encryption context (AAD)** = `tenant_id` + `engagement_id` + logical column
  path (not `row_id`). Propagation via `AsyncLocalStorage` (NestJS interceptor);
  an explicit `cipher` param for Temporal activities. DEK rotation = KMS auto CMK
  rotation + on-demand re-wrap; full re-encrypt deferred.
