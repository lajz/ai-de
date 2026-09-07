import { proxyActivities } from '@temporalio/workflow';

// Type-only: workflow code runs in Temporal's deterministic sandbox and must
// never pull in the real activity implementations (which import @fde/db,
// postgres, etc.) — only their input/output shapes.
import type { PingActivityInput, PingActivityResult } from '../activities/ping.js';

const { pingActivity } = proxyActivities<{
  pingActivity(input: PingActivityInput): Promise<PingActivityResult>;
}>({
  startToCloseTimeout: '30 seconds',
});

export interface PingWorkflowInput {
  nonce: string;
}

export type PingWorkflowResult = PingActivityResult;

/**
 * The trivial end-to-end loop: workflow -> activity -> back. `nonce` is an
 * opaque id-like token, not a body — proves the ids-only-payload convention
 * even at this scale.
 */
export async function pingWorkflow(input: PingWorkflowInput): Promise<PingWorkflowResult> {
  return pingActivity(input);
}
