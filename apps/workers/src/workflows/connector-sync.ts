import { ParentClosePolicy, proxyActivities, startChild } from '@temporalio/workflow';

import type { EngagementId, TenantId } from '@fde/core';

// Type-only — workflow code runs in Temporal's deterministic sandbox and must
// not pull in the real activity implementations (@fde/db, @fde/connectors,
// postgres). Only the input/output shapes.
import type {
  ConnectorSyncMode,
  RunConnectorSyncInput,
  RunConnectorSyncResult,
} from '../activities/connector-sync.js';
import type { ExtractionPipelineWorkflowInput } from './extraction-pipeline.js';

const { runConnectorSyncActivity } = proxyActivities<{
  runConnectorSyncActivity(i: RunConnectorSyncInput): Promise<RunConnectorSyncResult>;
}>({
  // A backfill drives the connector's whole async-iterable in one call, one
  // artifact at a time, each its own short encrypted transaction. It heartbeats
  // per artifact, so `heartbeatTimeout` catches a stuck connector well before
  // the `startToClose` ceiling.
  startToCloseTimeout: '30 minutes',
  heartbeatTimeout: '2 minutes',
  retry: { maximumAttempts: 3 },
});

/** Started as a child, run to completion independently of this workflow. */
const EXTRACTION_WORKFLOW_TYPE = 'extractionPipelineWorkflow';

export interface ConnectorSyncWorkflowInput {
  tenantId: TenantId;
  engagementId: EngagementId;
  /** a connector id registered in the worker's `ConnectorRegistry` (e.g. `'granola'`) */
  connectorId: string;
  mode: ConnectorSyncMode;
}

export interface ConnectorSyncWorkflowResult {
  connectorId: string;
  mode: ConnectorSyncMode;
  artifactCount: number;
  sourceCount: number;
  /** child `extractionPipelineWorkflow`s started for newly-landed transcript sources */
  extractionsStarted: number;
  cursor: string | null;
}

/**
 * The generic connector sync: run a connector's `backfill` / `incremental`
 * through `runConnectorSyncActivity` (which lands each artifact as an encrypted
 * `sources` row + an `acl_snapshots` row and advances `connector_sync_state`),
 * then start `extractionPipelineWorkflow` for every transcript source that newly
 * landed.
 *
 * Reusable across connectors — M2 Granola, M3 Linear — the connector id is just
 * an input. Ids-only payload: no artifact body ever enters workflow history.
 */
export async function connectorSyncWorkflow(
  input: ConnectorSyncWorkflowInput,
): Promise<ConnectorSyncWorkflowResult> {
  const result = await runConnectorSyncActivity(input);

  let extractionsStarted = 0;
  for (const sourceId of result.transcriptSourceIds) {
    if (await startExtractionChild(input, sourceId)) extractionsStarted += 1;
  }

  return {
    connectorId: result.connectorId,
    mode: result.mode,
    artifactCount: result.artifactCount,
    sourceCount: result.sourceCount,
    extractionsStarted,
    cursor: result.cursor,
  };
}

async function startExtractionChild(
  input: ConnectorSyncWorkflowInput,
  sourceId: string,
): Promise<boolean> {
  const args: ExtractionPipelineWorkflowInput = {
    tenantId: input.tenantId,
    engagementId: input.engagementId,
    sourceId,
  };
  try {
    // Deterministic id: a re-run of the sync (or a retry) never spawns a second
    // extraction for the same source. ABANDON — the pipeline outlives this
    // workflow, and this workflow does not wait for it.
    await startChild(EXTRACTION_WORKFLOW_TYPE, {
      workflowId: `extract-${input.engagementId}-${sourceId}`,
      args: [args],
      parentClosePolicy: ParentClosePolicy.ABANDON,
    });
    return true;
  } catch (err) {
    // Same deterministic id already running / completed from an earlier sync —
    // expected, not an error. Anything else propagates.
    if (err instanceof Error && err.name === 'WorkflowExecutionAlreadyStartedError') return false;
    throw err;
  }
}
