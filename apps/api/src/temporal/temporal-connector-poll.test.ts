import 'reflect-metadata';

import { ServiceUnavailableException } from '@nestjs/common';
import type { EngagementId, TenantId } from '@fde/core';
import { ScheduleNotFoundError, ScheduleOverlapPolicy } from '@temporalio/client';
import type { ScheduleClient } from '@temporalio/client';
import { describe, expect, it, vi } from 'vitest';

import { TemporalConnectorPoll } from './temporal.module.js';

const tenantId = 't-1' as TenantId;
const engagementId = 'e-1' as EngagementId;
const input = { tenantId, engagementId, connectorId: 'granola', intervalSeconds: 900 };
const notFound = () => new ScheduleNotFoundError('nope', 'connector-poll-e-1-granola');

function fakeClient(handle: { update?: unknown; delete?: unknown }) {
  const create = vi.fn(async () => undefined);
  const getHandle = vi.fn(() => handle);
  return {
    client: { create, getHandle } as unknown as ScheduleClient,
    create,
    getHandle,
  };
}

describe('TemporalConnectorPoll', () => {
  it('derives a deterministic schedule id per (engagement, connector)', () => {
    const poll = new TemporalConnectorPoll(null, 'q');
    expect(poll.scheduleId(engagementId, 'granola')).toBe('connector-poll-e-1-granola');
  });

  it('creates the schedule when none exists', async () => {
    const { client, create } = fakeClient({
      update: vi.fn(async () => {
        throw notFound();
      }),
    });
    await new TemporalConnectorPoll(client, 'q').upsert(input);
    expect(create).toHaveBeenCalledWith({
      scheduleId: 'connector-poll-e-1-granola',
      spec: { intervals: [{ every: 900_000 }] },
      action: {
        type: 'startWorkflow',
        workflowType: 'connectorSyncWorkflow',
        taskQueue: 'q',
        args: [{ tenantId, engagementId, connectorId: 'granola', mode: 'incremental' }],
      },
      policies: { overlap: ScheduleOverlapPolicy.SKIP },
    });
  });

  it('updates the interval in place when the schedule exists', async () => {
    const update = vi.fn(async () => undefined);
    const { client, create, getHandle } = fakeClient({ update });
    await new TemporalConnectorPoll(client, 'q').upsert(input);
    expect(getHandle).toHaveBeenCalledWith('connector-poll-e-1-granola');
    expect(create).not.toHaveBeenCalled();
    const fn = update.mock.calls[0]![0] as (prev: unknown) => {
      spec: unknown;
      action: { workflowType: string };
    };
    const next = fn({
      spec: { intervals: [{ every: 300_000 }] },
      action: { type: 'startWorkflow' },
    });
    expect(next.spec).toEqual({ intervals: [{ every: 900_000 }] });
    expect(next.action.workflowType).toBe('connectorSyncWorkflow');
  });

  it('remove is idempotent on not-found', async () => {
    const { client } = fakeClient({
      delete: vi.fn(async () => {
        throw notFound();
      }),
    });
    await expect(
      new TemporalConnectorPoll(client, 'q').remove({ engagementId, connectorId: 'granola' }),
    ).resolves.toBeUndefined();
  });

  it('remove deletes an existing schedule', async () => {
    const del = vi.fn(async () => undefined);
    const { client } = fakeClient({ delete: del });
    await new TemporalConnectorPoll(client, 'q').remove({ engagementId, connectorId: 'granola' });
    expect(del).toHaveBeenCalled();
  });

  it('503s when Temporal is unconfigured', async () => {
    const poll = new TemporalConnectorPoll(null, 'q');
    expect(poll.configured).toBe(false);
    await expect(poll.upsert(input)).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(poll.remove({ engagementId, connectorId: 'granola' })).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('503s when Temporal is unreachable', async () => {
    const boom = new Error('connect ECONNREFUSED');
    const { client } = fakeClient({
      update: vi.fn(async () => {
        throw boom;
      }),
      delete: vi.fn(async () => {
        throw boom;
      }),
    });
    const poll = new TemporalConnectorPoll(client, 'q');
    await expect(poll.upsert(input)).rejects.toThrow(/could not reach Temporal/);
    await expect(poll.remove({ engagementId, connectorId: 'granola' })).rejects.toThrow(
      /could not reach Temporal/,
    );
  });
});
