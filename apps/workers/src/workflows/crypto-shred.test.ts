import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import type { EngagementId, TenantId } from '@fde/core';
import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  PurgeShreddedCiphertextInput,
  PurgeShreddedCiphertextResult,
  ShredEngagementDekInput,
  ShredEngagementDekResult,
} from '../activities/crypto-shred.js';
import type { CryptoShredWorkflowInput, CryptoShredWorkflowResult } from './crypto-shred.js';

const workflowsPath = fileURLToPath(new URL('./index.ts', import.meta.url));

/**
 * Hand-rolled activity doubles — the workflow's job is strict ordering + id
 * plumbing between the two activities. The real DB read/write path is
 * `activities/crypto-shred.integration.test.ts`.
 */
function makeActivities(
  opts: {
    shred?: Partial<ShredEngagementDekResult>;
    purge?: Partial<PurgeShreddedCiphertextResult>;
  } = {},
) {
  const seen = {
    shred: [] as ShredEngagementDekInput[],
    purge: [] as PurgeShreddedCiphertextInput[],
  };
  const order: string[] = [];
  const activities = {
    async shredEngagementDekActivity(
      input: ShredEngagementDekInput,
    ): Promise<ShredEngagementDekResult> {
      seen.shred.push(input);
      order.push('shred');
      return { didShred: true, ...opts.shred };
    },
    async purgeShreddedCiphertextActivity(
      input: PurgeShreddedCiphertextInput,
    ): Promise<PurgeShreddedCiphertextResult> {
      seen.purge.push(input);
      order.push('purge');
      return { totalRowsPurged: 0, perTable: {}, ...opts.purge };
    },
  };
  return { activities, seen, order };
}

function input(overrides: Partial<CryptoShredWorkflowInput> = {}): CryptoShredWorkflowInput {
  return {
    tenantId: randomUUID() as TenantId,
    engagementId: randomUUID() as EngagementId,
    actorId: randomUUID(),
    reason: 'customer offboarded',
    ...overrides,
  };
}

describe('cryptoShredWorkflow', () => {
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
    wfInput: CryptoShredWorkflowInput,
  ): Promise<CryptoShredWorkflowResult> {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue,
      workflowsPath,
      activities,
    });
    return worker.runUntil(
      env.client.workflow.execute('cryptoShredWorkflow', {
        taskQueue,
        workflowId: `crypto-shred-${taskQueue}`,
        args: [wfInput],
      }),
    ) as Promise<CryptoShredWorkflowResult>;
  }

  it('runs the shred activity before the purge activity, with an ids-only payload', async () => {
    const { activities, seen, order } = makeActivities();
    const wfInput = input();
    const result = await run('cs-happy', activities, wfInput);

    expect(order).toEqual(['shred', 'purge']);
    expect(seen.shred).toEqual([
      {
        tenantId: wfInput.tenantId,
        engagementId: wfInput.engagementId,
        actorId: wfInput.actorId,
        reason: wfInput.reason,
      },
    ]);
    expect(seen.purge).toEqual([
      { tenantId: wfInput.tenantId, engagementId: wfInput.engagementId },
    ]);
    expect(result).toEqual({
      didShred: true,
      purge: { totalRowsPurged: 0, perTable: {} },
    });
  });

  it('still runs the purge when the shred activity reports it was already shredded (API called it synchronously first)', async () => {
    const { activities } = makeActivities({
      shred: { didShred: false },
      purge: { totalRowsPurged: 42, perTable: { facts: 42 } },
    });
    const result = await run('cs-already-shredded', activities, input());
    expect(result).toEqual({
      didShred: false,
      purge: { totalRowsPurged: 42, perTable: { facts: 42 } },
    });
  });
});
