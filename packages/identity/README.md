# @fde/identity

Cross-system person / organization identity resolution (M2, v1).

The same person is `jane@acme.com` (Google), `jsmith` (Slack), `Jane Smith`
(Jira). This package folds the `CanonicalEntity` records a connector's
`normalize` emits into stable rows in the `entities` table, accumulating every
`externalRef`.

**v1 rule: deterministic matches merge automatically; fuzzy matches are
queued for a human — never auto-merged.**

## API

| function                                                                            | what                                                                                                                          |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `resolveEntity(tx, tenantId, engagementId, canonicalEntity)`                        | deterministic upsert-by-identity; returns the entity id + whether it was created                                              |
| `findMatchCandidates(tx, tenantId, entityId)`                                       | score a just-resolved person against the tenant's other people; enqueue everything in the fuzzy band                          |
| `listPendingMatches(tx, tenantId)`                                                  | the review queue, best score first, with both entities' display names                                                         |
| `applyMatchDecision(tx, tenantId, { queueId, decision, decidedBy, keepEntityId? })` | `merge` folds one entity into the other and repoints its edges; `reject` records the negative. Both write an `access_log` row |
| `resolveNormalizedRecords(tx, tenantId, engagementId, records)`                     | the connector-sync seam — see below                                                                                           |
| `normalizeEmail` / `normalizeName` / `normalizeDomain`                              | the key normalizers                                                                                                           |

Every DB function takes the caller's **already-open** transaction (same contract
as the `@fde/db` read helpers) and opens none of its own. `resolveEntity` and
`resolveNormalizedRecords` must run inside `withEngagement` — they read and
rewrite the engagement-DEK-encrypted `entities.attributes` column.

## Deterministic keys

Connectors emit identity keys as `externalRefs` with sentinel `connector`
values, alongside the real origin refs:

| sentinel     | value                                                       | matches           |
| ------------ | ----------------------------------------------------------- | ----------------- |
| `fde:email`  | an email address (normalized: lower-cased, `+tag` stripped) | person            |
| `fde:sso`    | the SSO subject / `sub` claim                               | person            |
| `fde:domain` | an email domain (normalized: scheme/`www`/path stripped)    | organization only |

Match priority: exact origin ref → `fde:email` → `fde:sso` →
(organization) `fde:domain`. First tier with a hit wins; the incoming refs are
unioned onto the matched row and `attributes` are shallow-merged (incoming wins
per key). No hit → a new row.

The lookup is a `jsonb` containment (`external_refs @> …`) scoped by the
existing `entities_engagement_type_idx` — selective enough for v1 volumes; a GIN
index on `external_refs` is the follow-up if it isn't.

`resolveEntity` is a select-then-insert with no unique constraint on the derived
keys. That is safe under the connector-sync model — one Temporal activity writes
a given engagement at a time — and a duplicate that ever slips through is caught
by the next `findMatchCandidates` pass (identical name + refs → top score →
queued). A unique index on a generated key column is the hardening step if the
write path ever becomes concurrent.

## Fuzzy scoring

`scoreMatch` combines a Jaro-Winkler similarity of the normalized display names
with two corroborating booleans — shared email domain, shared `member_of`
organization. A pair scoring in `[QUEUE_THRESHOLD, AUTO_MERGE_THRESHOLD)` is
enqueued. `AUTO_MERGE_THRESHOLD` is `1` and the scorer caps at `0.99`, so **no
fuzzy score ever triggers an auto-merge** in v1. Pairs that already share an
exact ref are skipped (that's `resolveEntity`'s job). The unordered pair is
unique in the queue, so a `pending` / `merged` / `rejected` row is never
re-queued.

## Merge — FK repoint list

`applyMatchDecision('merge')` folds `drop` into `keep`:

1. union the cleartext `external_refs` onto `keep`;
2. repoint graph edges, coalescing any that would duplicate an edge `keep`
   already has (`relationships_edge_uq`):
   - `relationships.from_id` where `from_kind = 'entity'`
   - `relationships.to_id` where `to_kind = 'entity'`
   - `evidence` and `facts` carry **no** entity FK in the v1 schema — nothing to
     do there; `FK_REPOINT_TARGETS` lists them so a schema that adds one updates
     this code too;
3. delete `drop`. The `identity_review_queue.entity_{a,b}_id` FK cascade removes
   this row and any other pending pair that referenced `drop`.

**Not merged in v1:** the encrypted `attributes` / `body` of `drop`. The two
entities may sit under different engagement DEKs and `applyMatchDecision` holds
no crypto context, so `keep`'s encrypted fields simply stand. A follow-up that
runs inside both engagements' crypto contexts can fold them.

**Cross-engagement:** the queue is tenant-scoped and a pair _may_ span
engagements, but `applyMatchDecision('merge')` **rejects** a cross-engagement
pair (the entity crypto + graph scope is the engagement). Such a pair can be
`reject`ed or left pending for a follow-up. In practice connectors normalize per
engagement, so both sides of a real merge are almost always the same engagement.

Every decision writes one `access_log` row with `action = 'identity_merge'`
(`authzDecision.decision` is `'merge'` or `'reject'`).

## Integration seam (connector sync)

`@fde/identity` does **not** wire itself into connectors. A follow-up PR calls
`resolveNormalizedRecords` from `apps/workers` `ConnectorSync`, after a
connector's `normalize` step, inside the engagement crypto context:

```ts
// in the ConnectorSync normalize handler, within withEngagement(...)
const resolved = await resolveNormalizedRecords(tx, tenantId, engagementId, records);
// resolved[i].entityId        — the canonical entity id to hang facts/edges off
// resolved[i].candidates      — fuzzy matches that were queued for review
```

It resolves every `person` / `organization` entity record and scans each for
fuzzy candidates. `relationship` records and `work_item` / `document` /
`meeting` entities are left to the connector's own graph-write step.
