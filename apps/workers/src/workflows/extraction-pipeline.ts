import { proxyActivities, sleep, uuid4 } from '@temporalio/workflow';

import type { EngagementId, TenantId } from '@fde/core';

// Type-only — workflow code runs in Temporal's deterministic sandbox and must
// not pull in the real activity implementations (@fde/db, @fde/llm, postgres).
// Only the input/output shapes.
import type { ChunkOptions } from '../activities/chunk-transcript.js';
import type {
  PurgeRawBodyInput,
  PurgeRawBodyResult,
  RunExtractionInput,
  RunExtractionResult,
} from '../activities/extraction-pipeline.js';

const { runExtractionActivity } = proxyActivities<{
  runExtractionActivity(i: RunExtractionInput): Promise<RunExtractionResult>;
}>({
  // Generous: a long transcript is many bulk-tier model calls, one after another,
  // inside a single activity. It emits a heartbeat per chunk, so `heartbeatTimeout`
  // catches a stuck model call well before the `startToClose` ceiling.
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

const { purgeRawBodyActivity } = proxyActivities<{
  purgeRawBodyActivity(i: PurgeRawBodyInput): Promise<PurgeRawBodyResult>;
}>({
  // A handful of quick queries + one UPDATE — no heartbeat, short ceiling.
  startToCloseTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

export interface ExtractionPipelineWorkflowInput {
  tenantId: TenantId;
  engagementId: EngagementId;
  sourceId: string;
  /** pin a registered extraction prompt version; defaults to the latest */
  promptVersion?: string;
  chunking?: ChunkOptions;
}

export interface ExtractionPipelineWorkflowResult {
  extractionRunId: string;
  factCount: number;
  chunkCount: number;
  embeddingCount: number;
}

/**
 * Chunk an encrypted transcript `source` → structured extraction (Claude, ZDR,
 * bulk tier) → `facts` + `evidence` (🔒 quote + char span) + `embeddings`, every
 * row stamped with one `extraction_run_id`. Under `derived-ephemeral-raw` the
 * raw body is then purged once a durable timer reaches `purge_raw_after`.
 *
 * Ids-only payload: `{ tenantId, engagementId, sourceId }` — the transcript body
 * and its chunks never enter workflow history. All body handling is inside
 * `runExtractionActivity`.
 */
export async function extractionPipelineWorkflow(
  input: ExtractionPipelineWorkflowInput,
): Promise<ExtractionPipelineWorkflowResult> {
  // Generated here, in the workflow, so it is stable across activity retries —
  // a retry redoes the run idempotently against this same id.
  const extractionRunId = uuid4();

  const result = await runExtractionActivity({
    tenantId: input.tenantId,
    engagementId: input.engagementId,
    sourceId: input.sourceId,
    extractionRunId,
    promptVersion: input.promptVersion,
    chunking: input.chunking,
  });

  if (result.retentionPolicy === 'derived-ephemeral-raw' && result.purgeRawAfter) {
    const waitMs = Date.parse(result.purgeRawAfter) - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    await purgeRawBodyActivity({
      tenantId: input.tenantId,
      engagementId: input.engagementId,
      sourceId: input.sourceId,
      extractionRunId,
    });
  }

  return {
    extractionRunId,
    factCount: result.factCount,
    chunkCount: result.chunkCount,
    embeddingCount: result.embeddingCount,
  };
}
