import type { CanonicalRecord, EngagementId, TenantId } from '@fde/core';
import type { DbTransaction } from '@fde/db';

import { findMatchCandidates, type MatchCandidate } from './candidates.js';
import { resolveEntity, type ResolveEntityResult } from './resolve-entity.js';

export interface ResolvedRecord extends ResolveEntityResult {
  canonical: CanonicalRecord & { kind: 'entity' };
  candidates: MatchCandidate[];
}

/**
 * Integration seam for `apps/workers` `ConnectorSync` (wired in a follow-up PR).
 *
 * Given the `CanonicalRecord[]` a connector's `normalize` produced, resolve every
 * `person` / `organization` entity into the canonical `entities` table and scan
 * each for fuzzy match candidates. `relationship` records and `work_item` /
 * `document` / `meeting` entities are left to the connector's own graph-write
 * step (keyed directly by external ref) and ignored here.
 *
 * MUST be called inside `withEngagement` — `resolveEntity` touches the
 * engagement-DEK-encrypted `entities.attributes` column.
 */
export async function resolveNormalizedRecords(
  tx: DbTransaction,
  tenantId: TenantId,
  engagementId: EngagementId,
  records: readonly CanonicalRecord[],
): Promise<ResolvedRecord[]> {
  const out: ResolvedRecord[] = [];
  for (const rec of records) {
    if (rec.kind !== 'entity') continue;
    if (rec.type !== 'person' && rec.type !== 'organization') continue;
    const resolved = await resolveEntity(tx, tenantId, engagementId, rec);
    const candidates = await findMatchCandidates(tx, tenantId, resolved.entityId);
    out.push({ ...resolved, canonical: rec, candidates });
  }
  return out;
}
