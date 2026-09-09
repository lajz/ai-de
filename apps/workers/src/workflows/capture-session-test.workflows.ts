import { proxyActivities } from '@temporalio/workflow';

import type { ExtractionPipelineWorkflowInput } from './extraction-pipeline.js';

/**
 * Test-only workflow bundle for `capture-session.test.ts`: re-exports the real
 * `captureSessionWorkflow` unchanged, but swaps in a stub `extractionPipelineWorkflow`
 * — resolved by name when `captureSessionWorkflow` calls `startChild`. This keeps
 * the capture workflow test from depending on the real extraction activities
 * (`runExtractionActivity` / `purgeRawBodyActivity`, DB + LLM-backed); the stub
 * just records that it was started via an activity double so the test can assert
 * on it.
 */
export { captureSessionWorkflow } from './capture-session.js';

const { recordExtractionStartActivity } = proxyActivities<{
  recordExtractionStartActivity(i: ExtractionPipelineWorkflowInput): Promise<void>;
}>({ startToCloseTimeout: '10 seconds' });

export async function extractionPipelineWorkflow(input: ExtractionPipelineWorkflowInput) {
  await recordExtractionStartActivity(input);
  return { extractionRunId: 'stub-extraction-run', factCount: 0, chunkCount: 0, embeddingCount: 0 };
}
