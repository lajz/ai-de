import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { EngagementId, TenantId } from '@fde/core';
import { ActivityFailure, ApplicationFailure } from '@temporalio/common';
import { WorkflowFailedError } from '@temporalio/client';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  PurgeRawBodyInput,
  RunExtractionInput,
  RunExtractionResult,
} from '../activities/extraction-pipeline.js';
import type {
  ExtractionPipelineWorkflowInput,
  ExtractionPipelineWorkflowResult,
} from './extraction-pipeline.js';

const workflowsPath = fileURLToPath(new URL('./index.ts', import.meta.url));

/**
 * Hand-rolled activity doubles — the workflow's job is the id plumbing and the
 * durable purge timer, not the DB write path (that is
 * `activities/extraction-pipeline.integration.test.ts`).
 */
function makeActivities(runResult: Partial<RunExtractionResult> = {}) {
  const seen = { run: [] as RunExtractionInput[], purge: [] as PurgeRawBodyInput[] };
  const activities = {
    async runExtractionActivity(input: RunExtractionInput): Promise<RunExtractionResult> {
      seen.run.push(input);
      return {
        retentionPolicy: 'full-retention',
        purgeRawAfter: null,
        factCount: 3,
        chunkCount: 2,
        embeddingCount: 2,
        usdCost: 0.0012,
        modelCallCount: 2,
        unlocatableSpanCount: 0,
        ...runResult,
      };
    },
    async purgeRawBodyActivity(input: PurgeRawBodyInput) {
      seen.purge.push(input);
      return { purged: true };
    },
  };
  return { activities, seen };
}

function input(
  overrides: Partial<ExtractionPipelineWorkflowInput> = {},
): ExtractionPipelineWorkflowInput {
  return {
    tenantId: randomUUID() as TenantId,
    engagementId: randomUUID() as EngagementId,
    sourceId: randomUUID(),
    ...overrides,
  };
}

describe('extractionPipelineWorkflow', () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });
  afterAll(async () => {
    await env?.teardown();
  });

  async function run(
    taskQueue: string,
    activities: Record<string, unknown>,
    wfInput: ExtractionPipelineWorkflowInput,
  ): Promise<ExtractionPipelineWorkflowResult> {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath,
      activities,
    });
    return worker.runUntil(
      env.client.workflow.execute('extractionPipelineWorkflow', {
        taskQueue,
        workflowId: `extract-${taskQueue}`,
        args: [wfInput],
      }),
    ) as Promise<ExtractionPipelineWorkflowResult>;
  }

  it('runs one extraction activity with an ids-only payload and returns the counts', async () => {
    const { activities, seen } = makeActivities();
    const wfInput = input({ promptVersion: '2026-02-14' });
    const result = await run('ext-happy', activities, wfInput);

    expect(result).toMatchObject({ factCount: 3, chunkCount: 2, embeddingCount: 2 });
    expect(result.extractionRunId).toMatch(/[0-9a-f-]{36}/);
    expect(seen.run).toHaveLength(1);
    expect(seen.purge).toHaveLength(0);

    // ids + config only — no bodies. (Temporal's JSON payload converter drops
    // undefined-valued keys, so assert the set is a subset of what's allowed.)
    const allowed = [
      'tenantId',
      'engagementId',
      'sourceId',
      'extractionRunId',
      'promptVersion',
      'chunking',
    ];
    expect(Object.keys(seen.run[0]!).every((k) => allowed.includes(k))).toBe(true);
    expect(seen.run[0]).toMatchObject({
      tenantId: wfInput.tenantId,
      engagementId: wfInput.engagementId,
      sourceId: wfInput.sourceId,
      promptVersion: '2026-02-14',
    });
    expect(seen.run[0]!.extractionRunId).toBe(result.extractionRunId);
  });

  it('derived-ephemeral-raw: waits out the purge timer then nulls the body', async () => {
    const purgeRawAfter = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
    const { activities, seen } = makeActivities({
      retentionPolicy: 'derived-ephemeral-raw',
      purgeRawAfter,
    });
    const wfInput = input();
    await run('ext-purge', activities, wfInput);

    expect(seen.purge).toHaveLength(1);
    expect(seen.purge[0]).toMatchObject({
      tenantId: wfInput.tenantId,
      engagementId: wfInput.engagementId,
      sourceId: wfInput.sourceId,
      extractionRunId: seen.run[0]!.extractionRunId,
    });
  });

  it('reference-only source → the activity fails non-retryably and the workflow surfaces it', async () => {
    const activities = {
      async runExtractionActivity(): Promise<RunExtractionResult> {
        throw ApplicationFailure.create({
          type: 'NoRetainedBody',
          message:
            'no retained body to extract; reference-only transcripts are extracted inline at capture',
          nonRetryable: true,
        });
      },
      async purgeRawBodyActivity() {
        return { purged: false };
      },
    };
    const err = await run('ext-refonly', activities, input()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(WorkflowFailedError);
    // workflow → activity failure → the application failure the activity threw
    const activityFailure = (err as WorkflowFailedError).cause;
    expect(activityFailure).toBeInstanceOf(ActivityFailure);
    const appFailure = (activityFailure as ActivityFailure).cause;
    expect(appFailure).toBeInstanceOf(ApplicationFailure);
    expect((appFailure as ApplicationFailure).type).toBe('NoRetainedBody');
    expect((appFailure as ApplicationFailure).nonRetryable).toBe(true);
  });
});
