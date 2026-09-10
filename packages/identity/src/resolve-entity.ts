import type { CanonicalEntity, EngagementId, EntityId, ExternalRef, TenantId } from '@fde/core';
import { CRYPTO_COLUMNS, type DbTransaction, entities } from '@fde/db';
import { encryptRow, getCipher } from '@fde/crypto';
import { and, eq, or, type SQL, sql } from 'drizzle-orm';

import {
  deterministicKeys,
  type MatchKind,
  normalizeExternalRefs,
  tierKind,
  unionRefs,
} from './matching.js';

export interface ResolveEntityResult {
  entityId: EntityId;
  /** true when a new row was inserted, false when an existing entity was matched + merged */
  created: boolean;
  /** which deterministic key matched, or `null` when created */
  matchedBy: MatchKind | null;
}

const refContains = (key: { connector: string; externalId: string }): SQL =>
  sql`${entities.externalRefs} @> ${JSON.stringify([{ connector: key.connector, externalId: key.externalId }])}::jsonb`;

/**
 * Deterministic upsert-by-identity for one canonical `person` / `organization`.
 *
 * Match priority: exact origin `externalRef` → normalized email → SSO subject →
 * (organization) normalized domain. The first tier with a hit wins; the new
 * `externalRefs` are unioned onto the existing row and `attributes` are shallow-
 * merged (incoming wins per key). No hit → a new `entities` row.
 *
 * Pure-ish: takes the caller's already-open transaction and runs no I/O of its
 * own beyond it. MUST be called inside `withEngagement` — it reads and rewrites
 * the engagement-DEK-encrypted `attributes` column via the ambient crypto
 * context.
 */
export async function resolveEntity(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  canonical: CanonicalEntity,
): Promise<ResolveEntityResult> {
  const cipher = getCipher();
  const incomingRefs = normalizeExternalRefs(canonical.externalRefs);
  const keys = deterministicKeys(canonical);

  const scope = and(
    eq(entities.tenantId, tenantId),
    eq(entities.engagementId, engagementId),
    eq(entities.type, canonical.type),
  );

  // First tier with a hit wins and we return. If a lower-priority key would have
  // matched a *different* existing entity, v1 does not reconcile that here — the
  // incoming refs are unioned onto the winner, so a later `findMatchCandidates`
  // pass (or a re-resolve) is what surfaces the remaining near-duplicate.
  for (const tier of [...new Set(keys.map((k) => k.tier))]) {
    const clauses = keys.filter((k) => k.tier === tier).map(refContains);
    const [hit] = await tx
      .select({
        id: entities.id,
        externalRefs: entities.externalRefs,
        attributes: entities.attributes,
        body: entities.body,
      })
      .from(entities)
      .where(and(scope, or(...clauses)))
      .limit(1);
    if (!hit) continue;

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
        externalRefs: unionRefs(hit.externalRefs, incomingRefs),
        attributes: enc.attributes,
        // only fill an empty body — never overwrite one the graph already has
        ...(hit.body == null && enc.body != null ? { body: enc.body } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(entities.tenantId, tenantId), eq(entities.id, hit.id)));

    return { entityId: hit.id as EntityId, created: false, matchedBy: tierKind(tier) };
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
      externalRefs: incomingRefs as ExternalRef[],
      attributes: enc.attributes,
      body: enc.body ?? null,
    })
    .returning({ id: entities.id });

  return { entityId: row!.id as EntityId, created: true, matchedBy: null };
}
