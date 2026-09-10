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
import { entities, relationships } from './schema/graph.js';
import { CRYPTO_COLUMNS } from './schema/tables.js';

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
      .where(and(eq(entities.tenantId, tenantId), eq(entities.id, hit.id)));
    return { entityId: hit.id as EntityId, created: false };
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
  return { entityId: row!.id as EntityId, created: true };
}

export interface GraphEdgeInput {
  fromKind: NodeKind;
  fromId: string;
  predicate: Predicate;
  toKind: NodeKind;
  toId: string;
  /** the source that attests this edge, when it came from a single artifact */
  sourceId?: string | null;
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
 * v1 is **entity-only**: it looks the ref up among `entities.external_refs`
 * (exact `{connector, externalId}` containment, tenant + engagement scoped).
 * `facts` carry no external ref in the current schema, so a `fact` endpoint is
 * never resolvable here — when facts gain origin refs this gains a second lookup.
 * A ref that matches nothing returns `null`; the caller defers that edge.
 */
export async function resolveEndpointRef(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  ref: ExternalRef,
): Promise<ResolvedEndpoint | null> {
  const [hit] = await tx
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
  return hit ? { kind: 'entity', id: hit.id } : null;
}
