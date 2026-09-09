import { createHash } from 'node:crypto';

import type { Ciphertext, EngagementId, RawArtifact, RetentionPolicy, TenantId } from '@fde/core';
import { rawArtifactSchema, storesRawBody } from '@fde/core';
import { encryptRow, type EngagementCipher } from '@fde/crypto';
import { CRYPTO_COLUMNS } from '@fde/db';

/**
 * The connector analogue of `transcript-source.ts`: a schema-validated
 * `RawArtifact` from any `Connector` → a `sources` insert row whose `raw_body`
 * is field-encrypted with the engagement DEK (`encryptRow` + `CRYPTO_COLUMNS.sources`),
 * or left null under `reference-only`.
 *
 * Pure: no DB, no network. The `ConnectorSync` activity owns the transaction and
 * passes the engagement `cipher` explicitly (the crypto-boundary convention).
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
