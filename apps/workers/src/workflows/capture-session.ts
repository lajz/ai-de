import {
  ApplicationFailure,
  condition,
  defineSignal,
  proxyActivities,
  setHandler,
  uuid4,
} from '@temporalio/workflow';

import type { EngagementId, RetentionPolicy, TenantId } from '@fde/core';

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
}

export interface CaptureSessionWorkflowResult {
  captureSessionId: string;
  sourceId: string;
  /** false under reference-only — the transcript body was not persisted */
  bodyRetained: boolean;
}

/**
 * Signal seam: a Recall `transcript.done` webhook (received by `apps/api`, not
 * yet built) will `signalWorkflow(workflowId, transcriptReadySignal)` to end the
 * poll wait early. Until then the poll loop below is the live path; the signal
 * just short-circuits a single `POLL_INTERVAL` sleep when it does arrive.
 */
export const transcriptReadySignal = defineSignal('transcriptReady');

const POLL_INTERVAL = '30 seconds';
/** 240 × 30s ≈ 2h — the ceiling on how long we wait for a meeting to finish. */
const MAX_POLLS = 240;

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
  for (let poll = 0; poll < MAX_POLLS; poll++) {
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
    nudged = false;
    await condition(() => nudged, POLL_INTERVAL);
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

  return {
    captureSessionId,
    sourceId: stored.sourceId,
    bodyRetained: stored.bodyRetained,
  };
}
