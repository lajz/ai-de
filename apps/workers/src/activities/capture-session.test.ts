import { FakeKeyProvider } from '@fde/crypto';
import { describe, expect, it } from 'vitest';

import { FakeRecallClient } from '../capture/index.js';
import { createCaptureSessionActivities } from './capture-session.js';

const ids = {
  tenantId: '11111111-1111-1111-1111-111111111111',
  engagementId: '22222222-2222-2222-2222-222222222222',
  captureSessionId: '33333333-3333-3333-3333-333333333333',
} as const;

describe('capture-session activities (no DB)', () => {
  it('pollCaptureBotActivity passes the normalized bot state through', async () => {
    const recall = new FakeRecallClient({ failOnPoll: 1, failureReason: 'kicked' });
    const { botId } = await recall.scheduleBot({ meetingUrl: 'm', joinAt: 'j' });
    const acts = createCaptureSessionActivities({
      db: null as never,
      keyProvider: new FakeKeyProvider(),
      recallClient: recall,
    });

    const state = await acts.pollCaptureBotActivity({ botId });
    expect(state).toEqual({ botId, status: 'failed', failureReason: 'kicked' });
  });

  it('storeTranscriptSourceActivity rejects an empty transcript before touching the DB', async () => {
    const recall = new FakeRecallClient({ transcript: [] });
    const { botId } = await recall.scheduleBot({ meetingUrl: 'm', joinAt: 'j' });
    const acts = createCaptureSessionActivities({
      db: null as never, // the empty-transcript guard fires before any DB access
      keyProvider: new FakeKeyProvider(),
      recallClient: recall,
    });

    await expect(
      acts.storeTranscriptSourceActivity({
        ...ids,
        botId,
        meetingUrl: 'https://meet.example/x',
        joinAt: '2026-09-07T15:00:00.000Z',
        retentionPolicy: 'full-retention',
      } as never),
    ).rejects.toThrow(/empty/);
  });
});
