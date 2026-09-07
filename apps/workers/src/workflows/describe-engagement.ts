import { proxyActivities } from '@temporalio/workflow';

// Type-only — see the comment in ping.ts.
import type {
  DescribeEngagementInput,
  DescribeEngagementResult,
} from '../activities/describe-engagement.js';

const { describeEngagementActivity } = proxyActivities<{
  describeEngagementActivity(input: DescribeEngagementInput): Promise<DescribeEngagementResult>;
}>({
  startToCloseTimeout: '30 seconds',
});

/**
 * Worked example of the crypto-boundary convention end to end: this workflow's
 * input is `{ tenantId, engagementId }` — ids only, exactly what Temporal
 * persists in workflow history — never a cipher, a DEK, or 🔒 body content.
 * `describeEngagementActivity` is where those ids become a live cipher (see
 * `activities/engagement-context.ts`).
 */
export async function describeEngagementWorkflow(
  input: DescribeEngagementInput,
): Promise<DescribeEngagementResult> {
  return describeEngagementActivity(input);
}
