import { fileURLToPath } from 'node:url';

import { TestWorkflowEnvironment } from '@temporalio/testing';
import { Worker } from '@temporalio/worker';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { PingActivityInput, PingActivityResult } from '../activities/ping.js';
import { pingActivity } from '../activities/ping.js';

describe('pingWorkflow', () => {
  let env: TestWorkflowEnvironment;

  beforeAll(async () => {
    // Time-skipping test server — downloaded once and cached, no real Temporal
    // cluster needed, so this runs in CI.
    env = await TestWorkflowEnvironment.createTimeSkipping();
  });

  afterAll(async () => {
    await env?.teardown();
  });

  it('round-trips a nonce through the activity and back', async () => {
    const worker = await Worker.create({
      connection: env.nativeConnection,
      taskQueue: 'ping-test',
      workflowsPath: fileURLToPath(new URL('./index.ts', import.meta.url)),
      activities: { pingActivity },
    });

    const result = await worker.runUntil(
      env.client.workflow.execute('pingWorkflow', {
        taskQueue: 'ping-test',
        workflowId: 'ping-test-workflow',
        args: [{ nonce: 'abc-123' } satisfies PingActivityInput],
      }),
    );

    const typed = result as PingActivityResult;
    expect(typed.nonce).toBe('abc-123');
    expect(new Date(typed.at).toISOString()).toBe(typed.at);
  });
});
