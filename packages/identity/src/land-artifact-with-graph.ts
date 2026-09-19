import type { Connector } from '@fde/core';
import { rawArtifactSchema } from '@fde/core';
import { getCipher, type KeyProvider } from '@fde/crypto';
import {
  connectorContentHash,
  findExistingSourceId,
  landConnectorArtifactTx,
  sourceDedupeFilter,
  withEngagement,
  type Database,
  type LandConnectorArtifactInput,
} from '@fde/db';

import { persistGraph, ZERO_TALLY, type GraphWriteTally } from './persist-graph.js';

export interface LandConnectorArtifactWithGraphInput extends LandConnectorArtifactInput {
  /** the connector whose `normalize()` produces the canonical records to persist */
  connector: Connector;
}

export interface LandConnectorArtifactWithGraphResult {
  /** false when a `(engagement, connector, external_id, content_hash)` row already existed */
  inserted: boolean;
  sourceId: string;
  /** canonical-graph write tally (metadata only) — see `GraphWriteTally` */
  graph: GraphWriteTally;
}

/**
 * The webhook-delivery analogue of `apps/workers`' `ConnectorSync.ingestArtifact`:
 * dedupe → encrypted `sources` row → `acl_snapshots` row → canonical graph, all
 * inside **one** engagement transaction — a crash rolls the source back with
 * it, same reasoning `ingestArtifact` documents for the polling path.
 *
 * `packages/db`'s `landConnectorArtifactTx` owns the sources/acl_snapshots
 * half (shared, unmodified, with `landConnectorArtifact`); `persistGraph`
 * (this package) owns the graph half. Composed here rather than inside
 * `@fde/db` because `persistGraph` needs `resolveNormalizedRecords`, and
 * `@fde/db` cannot depend on `@fde/identity` (which already depends on
 * `@fde/db`) without a cycle.
 *
 * A dedupe hit skips the graph write entirely (`ZERO_TALLY`) — `normalize`
 * would recompute the same idempotent writes, but there is nothing new to
 * attest and no new `sourceId` to stamp an edge with, so skipping matches
 * `ConnectorSync`'s own re-run behaviour.
 */
export async function landConnectorArtifactWithGraph(
  db: Database,
  keyProvider: KeyProvider,
  input: LandConnectorArtifactWithGraphInput,
): Promise<LandConnectorArtifactWithGraphResult> {
  // Cheap pre-check outside the crypto path — mirrors `landConnectorArtifact` /
  // `ConnectorSync.ingestArtifact`: a redelivered webhook skips the DEK unwrap
  // (and the graph write, which needs nothing new to attest) entirely.
  const artifact = rawArtifactSchema.parse(input.artifact);
  const dedupe = sourceDedupeFilter(
    input.tenantId,
    input.engagementId,
    input.connectorId,
    artifact.externalId,
    connectorContentHash(artifact),
  );
  const existingId = await findExistingSourceId(db, input.tenantId, dedupe);
  if (existingId) return { inserted: false, sourceId: existingId, graph: ZERO_TALLY };

  return withEngagement(
    db,
    keyProvider,
    { tenantId: input.tenantId, engagementId: input.engagementId },
    async (tx) => {
      const cipher = getCipher();
      const landed = await landConnectorArtifactTx(tx, cipher, input);
      if (!landed.inserted) return { ...landed, graph: ZERO_TALLY };

      const graph = await persistGraph(
        { tenantId: input.tenantId, engagementId: input.engagementId, cipher, tx },
        input.connector,
        artifact,
        landed.sourceId,
      );
      return { ...landed, graph };
    },
  );
}
