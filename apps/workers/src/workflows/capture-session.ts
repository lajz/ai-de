import {
  ApplicationFailure,
  condition,
  defineSignal,
  log,
  ParentClosePolicy,
  proxyActivities,
  setHandler,
  startChild,
  uuid4,
  WorkflowIdReusePolicy,
} from '@temporalio/workflow';

import type { EngagementId, RetentionPolicy, TenantId } from '@fde/core';
// Not re-exported from `@temporalio/workflow` (only a curated subset of
// `@temporalio/common`'s errors is) — deterministic-safe, no runtime behavior.
import { WorkflowExecutionAlreadyStartedError } from '@temporalio/common';

// Type-only — workflow code runs in Temporal's deterministic sandbox and must
// not pull in the real activity implementations (@fde/db, postgres, the Recall
// HTTP client). Only the input/output shapes.
import type {
  PollCaptureBotInput,
  PollCaptureBotResult,
  ScheduleCaptureBotInput,
  ScheduleCaptureBotResult,
  StoreTranscriptSourceInput,
  StoreTranscriptSourceResult,
} from '../activities/capture-session.js';
// Type-only — `startChild` is called by workflow-type name string below; this
// import only pins the arg/result shape so the call stays type-checked.
import type { extractionPipelineWorkflow } from './extraction-pipeline.js';

const { scheduleCaptureBotActivity, pollCaptureBotActivity, storeTranscriptSourceActivity } =
  proxyActivities<{
    scheduleCaptureBotActivity(i: ScheduleCaptureBotInput): Promise<ScheduleCaptureBotResult>;
    pollCaptureBotActivity(i: PollCaptureBotInput): Promise<PollCaptureBotResult>;
    storeTranscriptSourceActivity(
      i: StoreTranscriptSourceInput,
    ): Promise<StoreTranscriptSourceResult>;
  }>({
    startToCloseTimeout: '2 minutes',
    retry: { maximumAttempts: 5 },
  });

export interface CaptureSessionWorkflowInput {
  tenantId: TenantId;
  engagementId: EngagementId;
  meetingUrl: string;
  /** ISO-8601 — when the bot should join */
  joinAt: string;
  retentionPolicy: RetentionPolicy;
  /**
   * Poll-cadence overrides (optional). Defaults: poll every 30s, up to 240
   * times (~2h ceiling on a meeting). The webhook signal seam makes the
   * interval a ceiling per wait, not a fixed delay.
   */
  pollIntervalSeconds?: number;
  maxPollAttempts?: number;
}

export interface CaptureSessionWorkflowResult {
  captureSessionId: string;
  sourceId: string;
  /** false under reference-only — the transcript body was not persisted */
  bodyRetained: boolean;
  /** null when extraction was skipped (nothing retained to extract) */
  extractionWorkflowId: string | null;
}

/**
 * Signal seam: a Recall `transcript.done` webhook (received by `apps/api`, not
 * yet built) will `signalWorkflow(workflowId, transcriptReadySignal)` to end the
 * poll wait early. Until then the poll loop below is the live path; the signal
 * just short-circuits a single `POLL_INTERVAL` sleep when it does arrive.
 */
export const transcriptReadySignal = defineSignal('transcriptReady');

const DEFAULT_POLL_INTERVAL_SECONDS = 30;
/** 240 × 30s ≈ 2h — the ceiling on how long we wait for a meeting to finish. */
const DEFAULT_MAX_POLL_ATTEMPTS = 240;

/**
 * Schedule a Recall.ai bot for a meeting, wait for the recording to finish, then
 * land the transcript as an encrypted `sources` row.
 *
 * Ids-only payload: `{ tenantId, engagementId, meetingUrl, joinAt,
 * retentionPolicy }` — no transcript body ever enters workflow history. The
 * body is fetched and encrypted entirely inside `storeTranscriptSourceActivity`.
 */
export async function captureSessionWorkflow(
  input: CaptureSessionWorkflowInput,
): Promise<CaptureSessionWorkflowResult> {
  let nudged = false;
  setHandler(transcriptReadySignal, () => {
    nudged = true;
  });

  const pollIntervalMs = (input.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS) * 1000;
  const maxPollAttempts = input.maxPollAttempts ?? DEFAULT_MAX_POLL_ATTEMPTS;

  const captureSessionId = uuid4();

  const { botId } = await scheduleCaptureBotActivity({
    tenantId: input.tenantId,
    engagementId: input.engagementId,
    captureSessionId,
    meetingUrl: input.meetingUrl,
    joinAt: input.joinAt,
    retentionPolicy: input.retentionPolicy,
  });

  let ready = false;
  for (let poll = 0; poll < maxPollAttempts; poll++) {
    // Consume any webhook nudge that arrived during the previous wait *before*
    // the poll, so a nudge delivered while this poll runs is still seen by the
    // `condition` below (worst case: one redundant poll, never a missed signal).
    nudged = false;

    const state = await pollCaptureBotActivity({ botId });
    if (state.status === 'done') {
      ready = true;
      break;
    }
    if (state.status === 'failed') {
      // Retryable on purpose: the meeting/bot problem (host absent, wrong time,
      // transient Recall error) may clear on a re-run. A parent workflow or an
      // operator decides; this workflow just surfaces it as retryable.
      throw ApplicationFailure.create({
        type: 'RecallBotFailed',
        message: `Recall bot ${botId} failed: ${state.failureReason ?? 'unknown'}`,
        nonRetryable: false,
      });
    }
    // Wait out the poll interval, waking early if the webhook signal arrives.
    await condition(() => nudged, pollIntervalMs);
  }

  if (!ready) {
    throw ApplicationFailure.create({
      type: 'RecallCaptureTimeout',
      message: `Recall bot ${botId} did not finish within the capture window`,
      nonRetryable: false,
    });
  }

  const stored = await storeTranscriptSourceActivity({
    tenantId: input.tenantId,
    engagementId: input.engagementId,
    captureSessionId,
    botId,
    meetingUrl: input.meetingUrl,
    joinAt: input.joinAt,
    retentionPolicy: input.retentionPolicy,
  });

  // Auto-trigger extraction as a child workflow — but only when there's a body
  // to extract; `reference-only` persists no transcript text.
  //
  // `startChild` (not `executeChild`): capture should complete as soon as the
  // extraction run is *started*, not block on it — a long transcript's
  // extraction can run for tens of minutes, far longer than we want this
  // short-lived capture workflow open. `parentClosePolicy: ABANDON` detaches
  // the child's lifecycle from the parent's (capture completing does not
  // cancel/terminate extraction) while keeping it visible in the same
  // workflow tree for observability.
  //
  // The child `workflowId` is derived from `stored.sourceId`, not
  // `captureSessionId` — `storeTranscriptSourceActivity` dedupes on
  // `(engagementId, connector, botId, contentHash)`, so a genuine capture retry
  // (new workflow execution, same underlying Recall bot) resolves to the same
  // `sourceId` and therefore the same child id, while `captureSessionId` is a
  // fresh `uuid4()` every run and would not catch that case. Duplicate starts
  // are rejected outright (`workflowIdReusePolicy: REJECT_DUPLICATE`, so a
  // prior extraction run that already finished doesn't get silently re-run
  // under the same id) and surface as `WorkflowExecutionAlreadyStartedError`,
  // which we treat as success rather than a duplicate extraction run.
  let extractionWorkflowId: string | null = null;
  if (stored.bodyRetained) {
    const childWorkflowId = `extraction-${stored.sourceId}`;
    try {
      await startChild<typeof extractionPipelineWorkflow>('extractionPipelineWorkflow', {
        workflowId: childWorkflowId,
        parentClosePolicy: ParentClosePolicy.PARENT_CLOSE_POLICY_ABANDON,
        workflowIdReusePolicy: WorkflowIdReusePolicy.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
        args: [
          {
            tenantId: input.tenantId,
            engagementId: input.engagementId,
            sourceId: stored.sourceId,
          },
        ],
      });
      extractionWorkflowId = childWorkflowId;
    } catch (err) {
      if (!(err instanceof WorkflowExecutionAlreadyStartedError)) throw err;
      extractionWorkflowId = childWorkflowId;
    }
  } else {
    log.info('capture retained no body; skipping extraction', {
      captureSessionId,
      sourceId: stored.sourceId,
    });
  }

  return {
    captureSessionId,
    sourceId: stored.sourceId,
    bodyRetained: stored.bodyRetained,
    extractionWorkflowId,
  };
}
