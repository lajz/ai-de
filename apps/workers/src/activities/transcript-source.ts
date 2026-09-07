import { createHash } from 'node:crypto';

import type { Ciphertext, EngagementId, RawArtifact, RetentionPolicy, TenantId } from '@fde/core';
import { rawArtifactSchema, storesRawBody } from '@fde/core';
import { encryptRow, type EngagementCipher } from '@fde/crypto';
import { CRYPTO_COLUMNS } from '@fde/db';

import type { TranscriptSegment } from '../capture/recall-client.js';

/** `sources.connector` value for meetings the platform captures itself. */
export const RECALL_CONNECTOR = 'recall';

/** How long the field-encrypted raw transcript is kept under `derived-ephemeral-raw`. */
export const REPROCESSING_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Flatten Recall's word-level segments to one speaker-tagged line per segment. */
export function renderTranscriptText(segments: TranscriptSegment[]): string {
  return segments
    .map((seg) => {
      const line = seg.words
        .map((w) => w.text)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      return seg.speaker ? `${seg.speaker}: ${line}` : line;
    })
    .filter((line) => line.length > 0)
    .join('\n');
}

export interface BuildTranscriptSourceInput {
  tenantId: TenantId;
  engagementId: EngagementId;
  /** Recall bot id — the transcript's `external_id` for dedupe */
  botId: string;
  meetingUrl: string;
  /** ISO-8601 — the meeting time (bot join), stored as `sources.occurred_at` */
  occurredAt: string;
  segments: TranscriptSegment[];
  retentionPolicy: RetentionPolicy;
}

/** The `sources` insert row, with `rawBody` already field-encrypted (or absent under reference-only). */
export interface TranscriptSourceRow {
  tenantId: TenantId;
  engagementId: EngagementId;
  connector: string;
  externalId: string;
  kind: 'transcript';
  urlPermalink: string;
  occurredAt: Date;
  contentHash: string;
  rawObjectKey: null;
  rawBody?: Ciphertext;
  retentionPolicy: RetentionPolicy;
}

export interface BuiltTranscriptSource {
  row: TranscriptSourceRow;
  /** the parsed `RawArtifact` (schema-validated) the row was derived from */
  artifact: RawArtifact;
  /** true when the encrypted transcript body is persisted inline (policy ≠ reference-only) */
  bodyRetained: boolean;
  /** plaintext transcript length — metadata only, safe to log */
  transcriptChars: number;
}

/**
 * Transcript segments → a schema-valid `RawArtifact` (`kind: 'transcript'`) → a
 * `sources` insert row whose `raw_body` is field-encrypted through the
 * `@fde/crypto` mapper (`encryptRow` + `CRYPTO_COLUMNS.sources`) with the
 * engagement DEK — unless `retentionPolicy` is `reference-only`, in which case
 * only the permalink + metadata are kept and `raw_body` stays null.
 *
 * Pure: no DB, no network. The activity that calls this owns the transaction
 * and passes the engagement `cipher` as an explicit argument (the crypto-boundary
 * convention — see `engagement-context.ts`).
 */
export async function buildTranscriptSource(
  cipher: EngagementCipher,
  input: BuildTranscriptSourceInput,
): Promise<BuiltTranscriptSource> {
  const text = renderTranscriptText(input.segments);
  // hash the transcript we fetched even under reference-only (we don't store the
  // body, but the hash still identifies this capture for dedupe / audit)
  const contentHash = createHash('sha256').update(text, 'utf8').digest('hex');
  const retain = storesRawBody(input.retentionPolicy);

  const artifact = rawArtifactSchema.parse({
    connector: RECALL_CONNECTOR,
    externalId: input.botId,
    kind: 'transcript',
    urlPermalink: input.meetingUrl,
    occurredAt: input.occurredAt,
    // body + structured segments only when the policy permits retaining them;
    // reference-only keeps neither.
    ...(retain ? { body: text, raw: { botId: input.botId, segments: input.segments } } : {}),
    // A self-captured meeting has no origin-system ACL to snapshot; access is
    // governed by engagement membership. An empty rule set records that
    // explicitly. Persisting an acl_snapshots row is the Connector's
    // `resolveAcl` job, out of scope for capture.
    acl: { rules: [], capturedAt: new Date().toISOString(), ttlSeconds: 3600 },
  } satisfies RawArtifact);

  const baseRow = {
    tenantId: input.tenantId,
    engagementId: input.engagementId,
    connector: RECALL_CONNECTOR,
    externalId: input.botId,
    kind: 'transcript' as const,
    urlPermalink: input.meetingUrl,
    occurredAt: new Date(input.occurredAt),
    contentHash,
    rawObjectKey: null,
    rawBody: retain ? text : undefined,
    retentionPolicy: input.retentionPolicy,
  };

  const row = await encryptRow(cipher, CRYPTO_COLUMNS.sources, baseRow);

  return { row, artifact, bodyRetained: retain, transcriptChars: text.length };
}
