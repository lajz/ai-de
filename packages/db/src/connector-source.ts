import { createHash } from 'node:crypto';

import { and, eq } from 'drizzle-orm';

import type {
  AclSnapshot,
  Ciphertext,
  EngagementId,
  RawArtifact,
  RetentionPolicy,
  TenantId,
} from '@fde/core';
import { rawArtifactSchema, storesRawBody } from '@fde/core';
import { encryptRow, getCipher, type EngagementCipher, type KeyProvider } from '@fde/crypto';

import type { Database } from './client.js';
import { withEngagement } from './engagement.js';
import { withTenant } from './rls.js';
import { aclSnapshots, sources } from './schema/sources.js';
import { CRYPTO_COLUMNS } from './schema/tables.js';

/**
 * The connector analogue of `transcript-source.ts`: a schema-validated
 * `RawArtifact` from any `Connector` → a `sources` insert row whose `raw_body`
 * is field-encrypted with the engagement DEK (`encryptRow` + `CRYPTO_COLUMNS.sources`),
 * or left null under `reference-only`.
 *
 * `buildConnectorSource` is pure (no DB, no network) — `apps/workers`'
 * `ConnectorSync` activity calls it directly and owns its own transaction +
 * explicit `cipher`. `landConnectorArtifact` below is the higher-level,
 * transactional counterpart shared by `ConnectorSync` and the webhook receiver
 * (`apps/api/src/webhooks`): dedupe → encrypted `sources` row → `acl_snapshots`
 * row, the same discipline either caller would otherwise have to reimplement.
 */

/** sha256 over the artifact body (or its structured payload) — the `sources` dedupe hash. */
export function connectorContentHash(artifact: RawArtifact): string {
  const material = artifact.body ?? JSON.stringify(artifact.raw ?? {});
  return createHash('sha256').update(material, 'utf8').digest('hex');
}

export interface ConnectorSourceRow {
  tenantId: TenantId;
  engagementId: EngagementId;
  connector: string;
  externalId: string;
  kind: RawArtifact['kind'];
  urlPermalink: string | null;
  workspaceRef: string | null;
  containerRef: string | null;
  authorRef: string | null;
  occurredAt: Date;
  contentHash: string;
  rawObjectKey: null;
  rawBody?: Ciphertext;
  retentionPolicy: RetentionPolicy;
  aclSnapshotId: string | null;
}

export interface BuiltConnectorSource {
  row: ConnectorSourceRow;
  /** the re-parsed `RawArtifact` the row was derived from */
  artifact: RawArtifact;
  /** true when the encrypted body is persisted inline (policy ≠ reference-only) */
  bodyRetained: boolean;
  /** plaintext body length — metadata only, safe to log */
  bodyChars: number;
}

export interface BuildConnectorSourceInput {
  tenantId: TenantId;
  engagementId: EngagementId;
  artifact: RawArtifact;
  /** the connector's effective retention policy for this engagement */
  retentionPolicy: RetentionPolicy;
  /** the persisted `acl_snapshots.id` for this artifact, when one was written */
  aclSnapshotId: string | null;
}

export async function buildConnectorSource(
  cipher: EngagementCipher,
  input: BuildConnectorSourceInput,
): Promise<BuiltConnectorSource> {
  // Re-parse at the crypto boundary — the artifact came off a Connector, an
  // untrusted source (especially for future customer-authored connectors).
  const artifact = rawArtifactSchema.parse(input.artifact);
  const retain = storesRawBody(input.retentionPolicy);
  const body = retain ? artifact.body : undefined;
  const contentHash = connectorContentHash(artifact);

  const baseRow = {
    tenantId: input.tenantId,
    engagementId: input.engagementId,
    connector: artifact.connector,
    externalId: artifact.externalId,
    kind: artifact.kind,
    urlPermalink: artifact.urlPermalink ?? null,
    workspaceRef: artifact.workspaceRef ?? null,
    containerRef: artifact.containerRef ?? null,
    authorRef: artifact.authorRef ?? null,
    occurredAt: new Date(artifact.occurredAt),
    contentHash,
    rawObjectKey: null,
    rawBody: body,
    retentionPolicy: input.retentionPolicy,
    aclSnapshotId: input.aclSnapshotId,
  };

  const row = await encryptRow(cipher, CRYPTO_COLUMNS.sources, baseRow);

  return {
    row,
    artifact,
    bodyRetained: retain && body != null,
    bodyChars: artifact.body?.length ?? 0,
  };
}

export interface LandConnectorArtifactInput {
  tenantId: TenantId;
  engagementId: EngagementId;
  connectorId: string;
  /** the connector's effective retention policy for this engagement */
  retentionPolicy: RetentionPolicy;
  artifact: RawArtifact;
  /** already resolved via `connector.resolveAcl(ctx, artifact)` — kept out of
   * this transaction so its own network call never holds a DB lock */
  aclSnapshot: AclSnapshot;
}

export interface LandConnectorArtifactResult {
  /** false when a `(engagement, connector, external_id, content_hash)` row already existed */
  inserted: boolean;
  sourceId: string;
}

/**
 * Dedupe → encrypted `sources` row → `acl_snapshots` row, inside one engagement
 * transaction. This is `apps/workers`' `ConnectorSync.ingestArtifact` minus the
 * canonical-graph write (which needs `@fde/identity`, a workers-only
 * dependency) — the part every caller that only needs a durable `sources` row
 * shares, including the webhook receiver (`apps/api/src/webhooks`), which lands
 * one artifact per request rather than a stream.
 */
export async function landConnectorArtifact(
  db: Database,
  keyProvider: KeyProvider,
  input: LandConnectorArtifactInput,
): Promise<LandConnectorArtifactResult> {
  const artifact = rawArtifactSchema.parse(input.artifact);
  const contentHash = connectorContentHash(artifact);
  // tenantId is redundant under RLS (`withTenant` / `withEngagement` both scope
  // the session) but kept explicit — defence in depth, matching `ConnectorSync`.
  const dedupe = and(
    eq(sources.tenantId, input.tenantId),
    eq(sources.engagementId, input.engagementId),
    eq(sources.connector, input.connectorId),
    eq(sources.externalId, artifact.externalId),
    eq(sources.contentHash, contentHash),
  );

  // Cheap pre-check outside the crypto path — a redelivered webhook skips the
  // DEK unwrap entirely.
  const existingId = await withTenant(db, input.tenantId, async (tx) => {
    const [row] = await tx.select({ id: sources.id }).from(sources).where(dedupe).limit(1);
    return row?.id ?? null;
  });
  if (existingId) return { inserted: false, sourceId: existingId };

  return withEngagement(
    db,
    keyProvider,
    { tenantId: input.tenantId, engagementId: input.engagementId },
    async (tx) => {
      // Re-check inside the tx — guards a concurrent redelivery race.
      const [again] = await tx.select({ id: sources.id }).from(sources).where(dedupe).limit(1);
      if (again) return { inserted: false, sourceId: again.id };

      const cipher = getCipher();

      // 1. sources row first (acl_snapshot_id null) — a conflict here never
      //    orphans an acl_snapshots row.
      const built = await buildConnectorSource(cipher, {
        tenantId: input.tenantId,
        engagementId: input.engagementId,
        artifact,
        retentionPolicy: input.retentionPolicy,
        aclSnapshotId: null,
      });
      const [srcRow] = await tx
        .insert(sources)
        .values(built.row)
        .onConflictDoNothing({
          target: [
            sources.engagementId,
            sources.connector,
            sources.externalId,
            sources.contentHash,
          ],
        })
        .returning({ id: sources.id });
      if (!srcRow) {
        // Lost a race to a concurrent writer between the re-check and the
        // insert — the winner owns this source.
        const [raced] = await tx.select({ id: sources.id }).from(sources).where(dedupe).limit(1);
        return { inserted: false, sourceId: raced?.id ?? '' };
      }

      // 2. encrypted ACL snapshot, linked back onto the source.
      const aclRow = await encryptRow(cipher, CRYPTO_COLUMNS.acl_snapshots, {
        principalRules: input.aclSnapshot.rules,
      });
      const [aclInserted] = await tx
        .insert(aclSnapshots)
        .values({
          tenantId: input.tenantId,
          engagementId: input.engagementId,
          sourceRef: `${input.connectorId}:${artifact.externalId}`,
          principalRules: aclRow.principalRules,
          capturedAt: new Date(input.aclSnapshot.capturedAt),
          ttlSeconds: input.aclSnapshot.ttlSeconds,
        })
        .returning({ id: aclSnapshots.id });
      if (!aclInserted)
        throw new Error('landConnectorArtifact: acl_snapshots insert returned no row');

      await tx
        .update(sources)
        .set({ aclSnapshotId: aclInserted.id })
        .where(and(eq(sources.id, srcRow.id), eq(sources.engagementId, input.engagementId)));

      return { inserted: true, sourceId: srcRow.id };
    },
  );
}
