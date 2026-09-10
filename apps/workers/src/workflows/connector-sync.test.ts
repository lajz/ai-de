import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { EngagementId, TenantId } from '@fde/core';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  RunConnectorSyncInput,
  RunConnectorSyncResult,
} from '../activities/connector-sync.js';
import type { RunExtractionInput, RunExtractionResult } from '../activities/extraction-pipeline.js';
import type { ConnectorSyncWorkflowInput, ConnectorSyncWorkflowResult } from './connector-sync.js';

const workflowsPath = fileURLToPath(new URL('./index.ts', import.meta.url));

/**
 * Hand-rolled activity doubles — the workflow's job is the id plumbing and
 * fanning out one child `extractionPipelineWorkflow` per newly-landed transcript
 * source. The DB write path is `activities/connector-sync.integration.test.ts`.
 */
function makeActivities(syncResult: Partial<RunConnectorSyncResult> = {}) {
  const seen = { sync: [] as RunConnectorSyncInput[], extract: [] as RunExtractionInput[] };
  const activities = {
    async runConnectorSyncActivity(input: RunConnectorSyncInput): Promise<RunConnectorSyncResult> {
      seen.sync.push(input);
      return {
        connectorId: input.connectorId,
        mode: input.mode,
        artifactCount: 3,
        sourceCount: 2,
        transcriptSourceIds: ['src-a', 'src-b'],
        cursor: '2026-09-03T12:15:00.000Z',
        graph: {
          entitiesResolved: 4,
          entitiesUpserted: 2,
          relationshipsUpserted: 3,
          relationshipsDeferred: 0,
          matchCandidatesQueued: 1,
        },
        ...syncResult,
      };
    },
    async runExtractionActivity(input: RunExtractionInput): Promise<RunExtractionResult> {
      seen.extract.push(input);
      return {
        retentionPolicy: 'full-retention',
        purgeRawAfter: null,
        factCount: 1,
        chunkCount: 1,
        embeddingCount: 1,
        usdCost: 0,
        modelCallCount: 1,
        unlocatableSpanCount: 0,
      };
    },
    async purgeRawBodyActivity() {
      return { purged: false };
    },
  };
  return { activities, seen };
}

function input(overrides: Partial<ConnectorSyncWorkflowInput> = {}): ConnectorSyncWorkflowInput {
  return {
    tenantId: randomUUID() as TenantId,
    engagementId: randomUUID() as EngagementId,
    connectorId: 'granola',
    mode: 'backfill',
    ...overrides,
  };
}

describe('connectorSyncWorkflow', () => {
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
    wfInput: ConnectorSyncWorkflowInput,
  ): Promise<ConnectorSyncWorkflowResult> {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath,
      activities,
    });
    return worker.runUntil(
      env.client.workflow.execute('connectorSyncWorkflow', {
        taskQueue,
        workflowId: `sync-${taskQueue}`,
        args: [wfInput],
      }),
    ) as Promise<ConnectorSyncWorkflowResult>;
  }

  it('runs the sync activity with an ids-only payload and returns its counts', async () => {
    const { activities, seen } = makeActivities();
    const wfInput = input();
    const result = await run('sync-happy', activities, wfInput);

    expect(result).toMatchObject({
      connectorId: 'granola',
      mode: 'backfill',
      artifactCount: 3,
      sourceCount: 2,
      extractionsStarted: 2,
      cursor: '2026-09-03T12:15:00.000Z',
      graph: { entitiesResolved: 4, entitiesUpserted: 2, relationshipsUpserted: 3 },
    });
    expect(seen.sync).toEqual([
      {
        tenantId: wfInput.tenantId,
        engagementId: wfInput.engagementId,
        connectorId: 'granola',
        mode: 'backfill',
      },
    ]);
  });

  it('starts one child extractionPipelineWorkflow per transcript source, with a deterministic id', async () => {
    const { activities } = makeActivities();
    const wfInput = input();
    await run('sync-fanout', activities, wfInput);

    for (const sourceId of ['src-a', 'src-b']) {
      const child = env.client.workflow.getHandle(`extract-${wfInput.engagementId}-${sourceId}`);
      const desc = await child.describe();
      expect(['RUNNING', 'COMPLETED']).toContain(desc.status.name);
    }
  });

  it('dedupe re-run: no transcript sources → no extraction children', async () => {
    const { activities, seen } = makeActivities({ transcriptSourceIds: [], sourceCount: 0 });
    const result = await run('sync-dedupe', activities, input());
    expect(result.extractionsStarted).toBe(0);
    expect(seen.extract).toHaveLength(0);
  });
});
