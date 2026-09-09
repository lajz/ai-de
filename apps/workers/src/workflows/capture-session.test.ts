import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { EngagementId, RetentionPolicy, TenantId } from '@fde/core';
import { createEngagementCipher, FakeKeyProvider } from '@fde/crypto';
import { WorkflowFailedError } from '@temporalio/client';
import { ApplicationFailure } from '@temporalio/common';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
import type { ExtractionPipelineWorkflowInput } from './extraction-pipeline.js';

// Points at the stub bundle (real `captureSessionWorkflow` + a fake
// `extractionPipelineWorkflow` that just records its input) so this suite never
// depends on the real, DB/LLM-backed extraction activities.
const workflowsPath = fileURLToPath(
  new URL('./capture-session-test.workflows.ts', import.meta.url),
);
const TENANT_CMK = 'fake:cmk';

/**
 * Test doubles for the three capture activities plus the extraction-start
 * recorder: the schedule + store steps run against `FakeRecallClient` +
 * `FakeKeyProvider` and land the `sources` row in an in-memory array (the DB
 * write path is covered by `activities/capture-session.integration.test.ts`).
 * `buildTranscriptSource` — the encryption-critical part — is the real
 * implementation. `sourceIdOverride` simulates the real store activity's
 * botId-keyed dedupe (see `capture-session.ts` activities) for the
 * duplicate-capture test, where two independent workflow executions must
 * resolve to the same `sourceId`.
 */
function makeCaptureActivities(recallOptions: FakeRecallOptions = {}, sourceIdOverride?: string) {
  const recall = new FakeRecallClient(recallOptions);
  const provider = new FakeKeyProvider();
  const tenantId = randomUUID() as TenantId;
  const engagementId = randomUUID() as EngagementId;
  const storedRows: TranscriptSourceRow[] = [];
  const extractionStarts: ExtractionPipelineWorkflowInput[] = [];
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
        sourceId: sourceIdOverride ?? `src-${storedRows.length}`,
        bodyRetained: built.bodyRetained,
        transcriptChars: built.transcriptChars,
      };
    },
    async recordExtractionStartActivity(input: ExtractionPipelineWorkflowInput) {
      extractionStarts.push(input);
    },
  };

  return { activities, storedRows, extractionStarts, recall, tenantId, engagementId };
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
  // A fresh env per test, not one shared `beforeAll` env: a shared time-skipping
  // server's auto-skip gets wedged after a prior test starts a child workflow —
  // a later test whose poll loop needs several sequential `condition()` skips
  // (the capture-timeout path) then hangs forever waiting on virtual time that
  // never advances. Isolating the env per test trades a little setup time for
  // never hitting that cross-test interaction.
  let env: TestWorkflowEnvironment;

  beforeEach(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });

  afterEach(async () => {
    await env?.teardown();
  });

  // Runs one capture execution on an already-started `worker` and, if it
  // started an extraction child (detached via `parentClosePolicy: ABANDON`),
  // waits for that child too — otherwise `runUntil`'s worker can shut down
  // before the child's workflow/activity tasks are ever picked up.
  async function executeOnce(
    taskQueue: string,
    workflowId: string,
    harness: ReturnType<typeof makeCaptureActivities>,
    retentionPolicy: RetentionPolicy,
  ): Promise<CaptureSessionWorkflowResult> {
    const result = (await env.client.workflow.execute('captureSessionWorkflow', {
      taskQueue,
      workflowId,
      args: [workflowInput(harness.tenantId, harness.engagementId, retentionPolicy)],
    })) as CaptureSessionWorkflowResult;
    if (result.extractionWorkflowId) {
      await env.client.workflow.getHandle(result.extractionWorkflowId).result();
    }
    return result;
  }

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
    return worker.runUntil(() =>
      executeOnce(taskQueue, `capture-${taskQueue}`, harness, retentionPolicy),
    );
  }

  it('happy path: lands one encrypted sources row and starts extraction', async () => {
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

    expect(result.extractionWorkflowId).toBe('extraction-src-1');
    expect(harness.extractionStarts).toHaveLength(1);
    expect(harness.extractionStarts[0]).toEqual({
      tenantId: harness.tenantId,
      engagementId: harness.engagementId,
      sourceId: 'src-1',
    });
  });

  it('reference-only: stores no transcript body and skips extraction', async () => {
    const harness = makeCaptureActivities({ pollsUntilDone: 1 });
    const result = await run('cap-refonly', harness, 'reference-only');

    expect(result.bodyRetained).toBe(false);
    expect(harness.storedRows[0]!.rawBody).toBeUndefined();
    expect(harness.storedRows[0]!.urlPermalink).toBe('https://meet.example/standup');

    expect(result.extractionWorkflowId).toBeNull();
    expect(harness.extractionStarts).toHaveLength(0);
  });

  it('duplicate capture (same underlying source) does not double-start extraction', async () => {
    const harness = makeCaptureActivities({ pollsUntilDone: 1 }, 'src-shared');
    const taskQueue = 'cap-dup';
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath,
      activities: harness.activities,
    });

    // One worker, two capture executions — the second's `sourceId` collides
    // with the first's (both forced to `src-shared`), so its extraction
    // `startChild` should hit the existing child id and be swallowed. Read the
    // child's `runId` after each capture (not just its `workflowId`, which the
    // second capture would report identically even if a *new* run had been
    // allowed under the same id) to prove the second `startChild` never created
    // a second execution.
    const [first, runIdAfterFirst, second, runIdAfterSecond] = await worker.runUntil(async () => {
      const r1 = await executeOnce(taskQueue, 'cap-dup-1', harness, 'full-retention');
      const runId1 = (await env.client.workflow.getHandle(r1.extractionWorkflowId!).describe())
        .runId;
      const r2 = await executeOnce(taskQueue, 'cap-dup-2', harness, 'full-retention');
      const runId2 = (await env.client.workflow.getHandle(r2.extractionWorkflowId!).describe())
        .runId;
      return [r1, runId1, r2, runId2] as const;
    });

    expect(first.extractionWorkflowId).toBe('extraction-src-shared');
    expect(second.extractionWorkflowId).toBe('extraction-src-shared');
    // both captures resolve to the same sourceId (dedupe hit), so the second
    // `startChild` collides on the deterministic child id and is swallowed as
    // `WorkflowExecutionAlreadyStartedError` — extraction only actually starts
    // once, and the second capture observes the *same* run, not a new one.
    expect(runIdAfterSecond).toBe(runIdAfterFirst);
    expect(harness.extractionStarts).toHaveLength(1);
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
