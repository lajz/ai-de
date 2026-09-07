import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { EngagementId, RetentionPolicy, TenantId } from '@fde/core';
import { createEngagementCipher, FakeKeyProvider } from '@fde/crypto';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  PollCaptureBotInput,
  ScheduleCaptureBotInput,
  StoreTranscriptSourceInput,
} from '../activities/capture-session.js';
import {
  buildTranscriptSource,
  type TranscriptSourceRow,
} from '../activities/transcript-source.js';
import { FakeRecallClient, type FakeRecallOptions } from '../capture/index.js';
import type {
  CaptureSessionWorkflowInput,
  CaptureSessionWorkflowResult,
} from './capture-session.js';

const workflowsPath = fileURLToPath(new URL('./index.ts', import.meta.url));
const TENANT_CMK = 'fake:cmk';

/**
 * Test doubles for the three capture activities: the schedule + store steps run
 * against `FakeRecallClient` + `FakeKeyProvider` and land the `sources` row in
 * an in-memory array (the DB write path is covered by
 * `activities/capture-session.integration.test.ts`). `buildTranscriptSource` —
 * the encryption-critical part — is the real implementation.
 */
function makeCaptureActivities(recallOptions: FakeRecallOptions = {}) {
  const recall = new FakeRecallClient(recallOptions);
  const provider = new FakeKeyProvider();
  const tenantId = randomUUID() as TenantId;
  const engagementId = randomUUID() as EngagementId;
  const storedRows: TranscriptSourceRow[] = [];
  let dek: Promise<{ wrappedDek: Uint8Array }> | undefined;

  const activities = {
    async scheduleCaptureBotActivity(input: ScheduleCaptureBotInput) {
      const { botId } = await recall.scheduleBot({
        meetingUrl: input.meetingUrl,
        joinAt: input.joinAt,
      });
      return { captureSessionId: input.captureSessionId, botId };
    },
    async pollCaptureBotActivity(input: PollCaptureBotInput) {
      const state = await recall.getBot(input.botId);
      return {
        botId: state.botId,
        status: state.status,
        ...(state.failureReason ? { failureReason: state.failureReason } : {}),
      };
    },
    async storeTranscriptSourceActivity(input: StoreTranscriptSourceInput) {
      const segments = await recall.getTranscript(input.botId);
      dek ??= provider.generateDek({ tenantId, engagementId, tenantCmkArn: TENANT_CMK });
      const { wrappedDek } = await dek;
      const cipher = await createEngagementCipher(provider, {
        tenantId,
        engagementId,
        tenantCmkArn: TENANT_CMK,
        wrappedDek,
      });
      const built = await buildTranscriptSource(cipher, {
        tenantId,
        engagementId,
        botId: input.botId,
        meetingUrl: input.meetingUrl,
        occurredAt: input.joinAt,
        segments,
        retentionPolicy: input.retentionPolicy,
      });
      storedRows.push(built.row);
      return {
        captureSessionId: input.captureSessionId,
        sourceId: `src-${storedRows.length}`,
        bodyRetained: built.bodyRetained,
        transcriptChars: built.transcriptChars,
      };
    },
  };

  return { activities, storedRows, recall, tenantId, engagementId };
}

function workflowInput(
  tenantId: TenantId,
  engagementId: EngagementId,
  retentionPolicy: RetentionPolicy,
  overrides: Partial<CaptureSessionWorkflowInput> = {},
): CaptureSessionWorkflowInput {
  return {
    tenantId,
    engagementId,
    meetingUrl: 'https://meet.example/standup',
    joinAt: '2026-09-07T15:00:00.000Z',
    retentionPolicy,
    // keep the poll loop short so a never-completing bot hits the ceiling fast
    pollIntervalSeconds: 30,
    maxPollAttempts: 5,
    ...overrides,
  };
}

describe('captureSessionWorkflow', () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });

  afterAll(async () => {
    await env?.teardown();
  });

  async function run(
    taskQueue: string,
    harness: ReturnType<typeof makeCaptureActivities>,
    retentionPolicy: RetentionPolicy,
  ): Promise<CaptureSessionWorkflowResult> {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: harness.activities,
    });
    return worker.runUntil(
      env.client.workflow.execute('captureSessionWorkflow', {
        taskQueue,
        workflowId: `capture-${taskQueue}`,
        args: [workflowInput(harness.tenantId, harness.engagementId, retentionPolicy)],
      }),
    ) as Promise<CaptureSessionWorkflowResult>;
  }

  it('happy path: lands one encrypted sources row and returns its id', async () => {
    const harness = makeCaptureActivities({ pollsUntilDone: 2 });
    const result = await run('cap-happy', harness, 'full-retention');

    expect(result.sourceId).toBe('src-1');
    expect(result.bodyRetained).toBe(true);
    expect(result.captureSessionId).toMatch(/[0-9a-f-]{36}/);
    expect(harness.recall.scheduledBotIds).toHaveLength(1);

    expect(harness.storedRows).toHaveLength(1);
    const row = harness.storedRows[0]!;
    expect(row.kind).toBe('transcript');
    expect(row.connector).toBe('recall');
    expect(row.rawBody).toBeInstanceOf(Uint8Array);
    // raw bytes are ciphertext, not the transcript text
    const bytes = Buffer.from(row.rawBody!).toString('utf8');
    expect(bytes).not.toContain('Friday');
    expect(bytes).not.toContain('decided');
  });

  it('reference-only: stores no transcript body', async () => {
    const harness = makeCaptureActivities({ pollsUntilDone: 1 });
    const result = await run('cap-refonly', harness, 'reference-only');

    expect(result.bodyRetained).toBe(false);
    expect(harness.storedRows[0]!.rawBody).toBeUndefined();
    expect(harness.storedRows[0]!.urlPermalink).toBe('https://meet.example/standup');
  });

  it('bot-failure path: surfaces a retryable ApplicationFailure', async () => {
    const harness = makeCaptureActivities({ failOnPoll: 1, failureReason: 'host never showed' });

    const err = await run('cap-fail', harness, 'full-retention').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowFailedError);
    const cause = (err as WorkflowFailedError).cause;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect((cause as ApplicationFailure).type).toBe('RecallBotFailed');
    expect((cause as ApplicationFailure).nonRetryable).toBe(false);
    expect(harness.storedRows).toHaveLength(0);
  });

  it('capture-timeout path: surfaces a retryable ApplicationFailure', async () => {
    const harness = makeCaptureActivities({ neverCompletes: true });

    const err = await run('cap-timeout', harness, 'full-retention').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowFailedError);
    const cause = (err as WorkflowFailedError).cause;
    expect(cause).toBeInstanceOf(ApplicationFailure);
    expect((cause as ApplicationFailure).type).toBe('RecallCaptureTimeout');
    expect((cause as ApplicationFailure).nonRetryable).toBe(false);
  });
});
