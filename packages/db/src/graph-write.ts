import { and, eq, or, type SQL, sql } from 'drizzle-orm';

import type {
  CanonicalEntity,
  EngagementId,
  EntityId,
  ExternalRef,
  NodeKind,
  Predicate,
  TenantId,
} from '@fde/core';
import { encryptRow, type EngagementCipher } from '@fde/crypto';

import type { DbTransaction } from './client.js';
import { evidence, facts } from './schema/facts.js';
import { entities, relationships } from './schema/graph.js';
import { CRYPTO_COLUMNS } from './schema/tables.js';

/** A fact's own row id, in canonical UUID text form — the only shape `resolveEndpointRef` accepts for an `fde:` ref. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Graph-write helpers for `ConnectorSync` — the persist step for the canonical
 * records a connector's `normalize` produces.
 *
 * Same contract as `retrieval.ts`: every function takes the caller's
 * **already-open** transaction (from `withEngagement` / `withTenant`), opens none
 * of its own, and pins both `tenant_id` and `engagement_id` in every predicate
 * (RLS + defence-in-depth). The two that touch the encrypted `entities.attributes`
 * / `entities.body` columns take the engagement `cipher` explicitly — nothing
 * here reads ambient crypto context.
 *
 * Division of labour with `@fde/identity`: `person` / `organization` entities go
 * through `resolveEntity` (deterministic identity tiers + fuzzy-match queue).
 * `work_item` / `document` / `meeting` entities — which carry no identity keys —
 * and every `relationship` edge are this module's job.
 */

const refKey = (r: ExternalRef): string => JSON.stringify([r.connector, r.externalId]);

/** Drop `url`, dedupe on `{connector, externalId}`, first occurrence wins. */
function normalizeRefs(refs: readonly ExternalRef[]): ExternalRef[] {
  const seen = new Set<string>();
  const out: ExternalRef[] = [];
  for (const r of refs) {
    const key = refKey(r);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ connector: r.connector, externalId: r.externalId });
  }
  return out;
}

/** `a ∪ b` over normalized refs, `a`'s order first. */
function unionRefs(a: readonly ExternalRef[], b: readonly ExternalRef[]): ExternalRef[] {
  return normalizeRefs([...a, ...b]);
}

/** `entities.external_refs @> [{connector, externalId}]` — jsonb containment. */
const refContains = (ref: ExternalRef): SQL =>
  sql`${entities.externalRefs} @> ${JSON.stringify([
    { connector: ref.connector, externalId: ref.externalId },
  ])}::jsonb`;

export interface UpsertEntityResult {
  entityId: EntityId;
  /** true when a new row was inserted, false when an existing row was matched + merged */
  created: boolean;
  /**
   * The matched row's decrypted `attributes` as they stood *before* this
   * write, or `null` when `created` is true — a brand-new entity has no prior
   * state to transition from. Lets a caller (`persistGraph`) detect a
   * lifecycle transition (e.g. a PR merging) without a second read.
   */
  previousAttributes: Record<string, unknown> | null;
}

/**
 * Upsert one `work_item` / `document` / `meeting` entity keyed purely by external
 * ref. Do NOT call this for `person` / `organization` — `@fde/identity`'s
 * `resolveEntity` owns those (and their email / SSO / domain match tiers).
 *
 * Match: any exact `{connector, externalId}` from `canonical.externalRefs` already
 * present in some row's `external_refs` (same tenant + engagement + type). Hit →
 * union refs onto the row and shallow-merge `attributes` (incoming wins per key),
 * re-encrypting via `encryptRow` + `CRYPTO_COLUMNS.entities`; an empty `body` is
 * filled, a present one is never overwritten. Miss → insert.
 *
 * Idempotent: a re-normalized artifact converges to the same row — refs union to
 * a fixed point and the attribute merge is stable.
 *
 * MUST run inside `withEngagement` (touches the engagement-DEK-encrypted
 * `attributes` column via `cipher`).
 */
export async function upsertEntityByRef(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  canonical: CanonicalEntity,
  cipher: EngagementCipher,
): Promise<UpsertEntityResult> {
  const refs = normalizeRefs(canonical.externalRefs);
  // `canonicalEntitySchema` enforces `.min(1)`; guard anyway so a direct caller
  // can't turn an empty ref list into an `or()` of nothing (→ match any row).
  if (refs.length === 0) {
    throw new Error('upsertEntityByRef: canonical entity has no externalRefs');
  }
  const scope = and(
    eq(entities.tenantId, tenantId),
    eq(entities.engagementId, engagementId),
    eq(entities.type, canonical.type),
  );

  const [hit] = await tx
    .select({
      id: entities.id,
      externalRefs: entities.externalRefs,
      attributes: entities.attributes,
      body: entities.body,
    })
    .from(entities)
    .where(and(scope, or(...refs.map(refContains))))
    .limit(1);

  if (hit) {
    const existingAttrs = await cipher.decryptJson<Record<string, unknown>>(
      CRYPTO_COLUMNS.entities[0].path,
      hit.attributes,
    );
    const enc = await encryptRow(cipher, CRYPTO_COLUMNS.entities, {
      attributes: { ...existingAttrs, ...canonical.attributes },
      body: canonical.body ?? null,
    });
    await tx
      .update(entities)
      .set({
        externalRefs: unionRefs(hit.externalRefs, refs),
        attributes: enc.attributes,
        ...(hit.body == null && enc.body != null ? { body: enc.body } : {}),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(entities.tenantId, tenantId),
          eq(entities.engagementId, engagementId),
          eq(entities.id, hit.id),
        ),
      );
    return { entityId: hit.id as EntityId, created: false, previousAttributes: existingAttrs };
  }

  const enc = await encryptRow(cipher, CRYPTO_COLUMNS.entities, {
    attributes: canonical.attributes,
    body: canonical.body ?? null,
  });
  const [row] = await tx
    .insert(entities)
    .values({
      tenantId,
      engagementId,
      type: canonical.type,
      displayName: canonical.displayName,
      externalRefs: refs,
      attributes: enc.attributes,
      body: enc.body ?? null,
    })
    .returning({ id: entities.id });
  return { entityId: row!.id as EntityId, created: true, previousAttributes: null };
}

export interface StatusChangeFactInput {
  /** short, non-encrypted label — `facts.summary` */
  summary: string;
  /** optional full detail — encrypted like any other fact body */
  body?: string | null;
  /** ISO-8601 timestamp the transition is attributed to */
  occurredAt: string;
  /** the source that attests the observation which produced this fact */
  sourceId: string;
}

/**
 * Insert one deterministic `status_change` fact + its single supporting
 * `evidence` row, mirroring the shape `apps/workers`' extraction pipeline uses
 * for model-produced facts — minus an `extractionRunId` (there is no
 * extraction run; this fact was synthesized directly from an observed entity
 * transition, and both `facts.extraction_run_id` / `evidence.extraction_run_id`
 * are nullable for exactly this case) and minus a char span (there is no
 * source-document quote to locate).
 *
 * `confidence: 1` — a deterministic, code-derived fact carries no model
 * uncertainty to record, unlike an LLM-extracted one.
 *
 * MUST run inside `withEngagement` (encrypts `facts.body` with the engagement
 * DEK via `cipher`).
 */
export async function insertStatusChangeFact(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  cipher: EngagementCipher,
  input: StatusChangeFactInput,
): Promise<{ factId: string }> {
  const factRow = await encryptRow(cipher, CRYPTO_COLUMNS.facts, { body: input.body ?? null });
  const [inserted] = await tx
    .insert(facts)
    .values({
      tenantId,
      engagementId,
      type: 'status_change',
      summary: input.summary,
      body: factRow.body ?? null,
      confidence: 1,
      occurredAt: new Date(input.occurredAt),
      extractionRunId: null,
    })
    .returning({ id: facts.id });
  const factId = inserted!.id;

  const evidenceRow = await encryptRow(cipher, CRYPTO_COLUMNS.evidence, { quote: null });
  await tx.insert(evidence).values({
    tenantId,
    engagementId,
    factId,
    sourceId: input.sourceId,
    quote: evidenceRow.quote ?? null,
    charStart: null,
    charEnd: null,
    relation: 'supports',
    extractionRunId: null,
  });

  return { factId };
}

export interface GraphEdgeInput {
  fromKind: NodeKind;
  fromId: string;
  predicate: Predicate;
  toKind: NodeKind;
  toId: string;
  /** the source that attests this edge, when it came from a single artifact */
  sourceId?: string | null;
  /** 0-1 model-judged confidence (agentic linking); omit/null for a deterministic edge */
  confidence?: number | null;
}

/**
 * Insert one directed edge, `onConflictDoNothing` against `relationships_edge_uq`
 * (`from_kind, from_id, predicate, to_kind, to_id`). A re-run re-normalizing the
 * same artifact is a no-op. On conflict the existing row's `source_id` is kept —
 * the first artifact to attest an edge owns its provenance stamp.
 *
 * Takes the caller's open transaction.
 */
export async function upsertRelationship(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  edge: GraphEdgeInput,
): Promise<{ inserted: boolean }> {
  const rows = await tx
    .insert(relationships)
    .values({
      tenantId,
      engagementId,
      fromKind: edge.fromKind,
      fromId: edge.fromId,
      predicate: edge.predicate,
      toKind: edge.toKind,
      toId: edge.toId,
      sourceId: edge.sourceId ?? null,
      confidence: edge.confidence ?? null,
    })
    .onConflictDoNothing({
      target: [
        relationships.fromKind,
        relationships.fromId,
        relationships.predicate,
        relationships.toKind,
        relationships.toId,
      ],
    })
    .returning({ id: relationships.id });
  return { inserted: rows.length > 0 };
}

/** A resolved graph endpoint — the node an `ExternalRef` points at. */
export type ResolvedEndpoint = { kind: 'entity' | 'fact'; id: string };

/**
 * Resolve a connector `ExternalRef` to the graph node it names, for stamping a
 * `relationship` endpoint.
 *
 * Two lookups:
 *
 * - `entities.external_refs` (exact `{connector, externalId}` containment,
 *   tenant + engagement scoped) — every connector-sourced endpoint.
 * - `facts.id`, only for `connector: 'fde'` refs whose `externalId` is a UUID.
 *   Facts carry no external-ref array of their own (unlike entities); a fact's
 *   own row id IS the portable identifier a human (or a connector-side marker,
 *   e.g. `LinearConnector`'s `fde:decision:<id>` convention) references once
 *   the fact exists. A non-UUID `externalId` — e.g. a marker token written
 *   before any matching fact was ever extracted — matches nothing without
 *   touching the DB with a value Postgres would reject as a UUID literal.
 *
 * A ref that matches neither returns `null`; the caller defers that edge (no
 * reconciliation pass retries it later — a documented follow-up. In practice
 * this only bites a `connector: 'fde'` ref that predates its fact: sync order
 * — extract first, then reference the fact's id in the downstream ticket —
 * avoids it).
 */
export async function resolveEndpointRef(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  ref: ExternalRef,
): Promise<ResolvedEndpoint | null> {
  const [entityHit] = await tx
    .select({ id: entities.id })
    .from(entities)
    .where(
      and(
        eq(entities.tenantId, tenantId),
        eq(entities.engagementId, engagementId),
        refContains(ref),
      ),
    )
    .limit(1);
  if (entityHit) return { kind: 'entity', id: entityHit.id };

  if (ref.connector === 'fde' && UUID_RE.test(ref.externalId)) {
    const [factHit] = await tx
      .select({ id: facts.id })
      .from(facts)
      .where(
        and(
          eq(facts.tenantId, tenantId),
          eq(facts.engagementId, engagementId),
          eq(facts.id, ref.externalId),
        ),
      )
      .limit(1);
    if (factHit) return { kind: 'fact', id: factHit.id };
  }

  return null;
}
