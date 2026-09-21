import { proxyActivities } from '@temporalio/workflow';

import type { EngagementId, TenantId } from '@fde/core';

// Type-only — workflow code runs in Temporal's deterministic sandbox and must
// not pull in the real activity implementations (@fde/db, @fde/llm, postgres).
// Only the input/output shapes.
import type {
  RunAgenticLinkingInput,
  RunAgenticLinkingResult,
} from '../activities/agentic-linking.js';

const { runAgenticLinkingActivity } = proxyActivities<{
  runAgenticLinkingActivity(i: RunAgenticLinkingInput): Promise<RunAgenticLinkingResult>;
}>({
  // One embed call + up to one bulk-tier LLM call + a handful of quick
  // queries — generous but not extraction-pipeline-scale (no heartbeat: there
  // is no long per-chunk loop to heartbeat against).
  startToCloseTimeout: '5 minutes',
  retry: { maximumAttempts: 3 },
});

export interface AgenticLinkingWorkflowInput {
  tenantId: TenantId;
  engagementId: EngagementId;
  /** the newly-created `work_item` entity to find links for */
  workItemEntityId: string;
  /** the `sources` row that landed this work item — stamped onto every edge written */
  sourceId: string;
}

export type AgenticLinkingWorkflowResult = RunAgenticLinkingResult;

/**
 * Auto-trigger from `apps/api`'s `WebhookLandingService` on first creation of
 * a `work_item` entity: find related work items (an identifier reference) and
 * meeting-derived facts (semantic similarity, LLM-judged), and write
 * `relates_to` edges directly — no human review queue (see the PR description
 * for why). Ids-only payload: no title/body text ever enters workflow
 * history — `runAgenticLinkingActivity` loads and decrypts the work item
 * itself.
 *
 * A thin single-activity wrapper (like `extractionPipelineWorkflow` wraps
 * `runExtractionActivity`) rather than inline activity logic in the caller —
 * this is what gives the linking pass Temporal's retry/observability/history
 * for free, and is the natural seam if a later version adds a step (e.g. a
 * reconsideration pass) without changing the trigger site.
 */
export async function agenticLinkingPipelineWorkflow(
  input: AgenticLinkingWorkflowInput,
): Promise<AgenticLinkingWorkflowResult> {
  return runAgenticLinkingActivity({
    tenantId: input.tenantId,
    engagementId: input.engagementId,
    workItemEntityId: input.workItemEntityId,
    sourceId: input.sourceId,
  });
}
