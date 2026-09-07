import { describe, expect, it } from 'vitest';

import { FakeRecallClient } from './fake-recall-client.js';
import { HttpRecallClient } from './http-recall-client.js';
import { RecallApiError } from './recall-client.js';

describe('FakeRecallClient', () => {
  it('schedules a bot and advances by poll count', async () => {
    const client = new FakeRecallClient({ pollsUntilDone: 3 });
    const { botId } = await client.scheduleBot({
      meetingUrl: 'https://x/y',
      joinAt: '2026-09-07T15:00:00Z',
    });
    expect(client.scheduledBotIds).toEqual([botId]);

    expect((await client.getBot(botId)).status).toBe('joining');
    expect((await client.getBot(botId)).status).toBe('in_call');
    expect((await client.getBot(botId)).status).toBe('done');
  });

  it('reports a terminal failure on the configured poll', async () => {
    const client = new FakeRecallClient({ failOnPoll: 2, failureReason: 'kicked out' });
    const { botId } = await client.scheduleBot({ meetingUrl: 'm', joinAt: 'j' });
    expect((await client.getBot(botId)).status).toBe('joining');
    const failed = await client.getBot(botId);
    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toBe('kicked out');
  });

  it('neverCompletes keeps returning in-progress states', async () => {
    const client = new FakeRecallClient({ neverCompletes: true });
    const { botId } = await client.scheduleBot({ meetingUrl: 'm', joinAt: 'j' });
    for (let i = 0; i < 10; i++) {
      expect(['joining', 'in_call']).toContain((await client.getBot(botId)).status);
    }
  });

  it('returns a defensive copy of the transcript', async () => {
    const client = new FakeRecallClient();
    const { botId } = await client.scheduleBot({ meetingUrl: 'm', joinAt: 'j' });
    const first = await client.getTranscript(botId);
    first[0]!.words[0]!.text = 'MUTATED';
    const second = await client.getTranscript(botId);
    expect(second[0]!.words[0]!.text).not.toBe('MUTATED');
  });

  it('rejects an unknown bot id', async () => {
    const client = new FakeRecallClient();
    await expect(client.getBot('nope')).rejects.toThrow(/unknown bot/);
  });
});

/** Minimal fetch stub — records the last request, returns a canned response. */
function stubFetch(response: { status?: number; json?: unknown; text?: string }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => response.json,
      text: async () => response.text ?? JSON.stringify(response.json ?? ''),
    } as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('HttpRecallClient', () => {
  const opts = (fetchImpl: typeof fetch) => ({
    apiKey: 'test-key',
    baseUrl: 'https://us-west-2.recall.ai',
    fetchImpl,
  });

  it('scheduleBot POSTs to /api/v1/bot/ with auth + recording config', async () => {
    const { impl, calls } = stubFetch({ status: 201, json: { id: 'bot-123' } });
    const client = new HttpRecallClient(opts(impl));

    const res = await client.scheduleBot({
      meetingUrl: 'https://meet.example/abc',
      joinAt: '2026-09-07T15:00:00Z',
      botName: 'Notetaker',
    });

    expect(res).toEqual({ botId: 'bot-123' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://us-west-2.recall.ai/api/v1/bot/');
    expect(calls[0]!.init.method).toBe('POST');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe('Token test-key');
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.meeting_url).toBe('https://meet.example/abc');
    expect(body.join_at).toBe('2026-09-07T15:00:00Z');
    expect(body.bot_name).toBe('Notetaker');
    expect(body.recording_config.transcript.provider).toEqual({ meeting_captions: {} });
  });

  it('getBot maps the latest status_change code to a normalized status', async () => {
    const done = new HttpRecallClient(
      opts(
        stubFetch({
          json: { id: 'b', status_changes: [{ code: 'joining_call' }, { code: 'done' }] },
        }).impl,
      ),
    );
    expect((await done.getBot('b')).status).toBe('done');

    const failed = new HttpRecallClient(
      opts(
        stubFetch({
          json: { id: 'b', status_changes: [{ code: 'fatal', message: 'meeting not found' }] },
        }).impl,
      ),
    );
    const state = await failed.getBot('b');
    expect(state.status).toBe('failed');
    expect(state.failureReason).toBe('meeting not found');

    const inCall = new HttpRecallClient(
      opts(stubFetch({ json: { id: 'b', status_changes: [{ code: 'call_ended' }] } }).impl),
    );
    expect((await inCall.getBot('b')).status).toBe('in_call');
  });

  it('getTranscript normalizes both timestamp shapes', async () => {
    const client = new HttpRecallClient(
      opts(
        stubFetch({
          json: [
            {
              speaker: 'Dana',
              words: [
                { text: 'Hi', start_timestamp: 1.5, end_timestamp: 1.9 },
                {
                  text: 'there',
                  start_timestamp: { relative: 2.0 },
                  end_timestamp: { relative: 2.4 },
                },
              ],
            },
            { participant: { name: 'Sam' }, words: [{ text: 'Yo', start_timestamp: null }] },
          ],
        }).impl,
      ),
    );
    const segs = await client.getTranscript('b');
    expect(segs[0]).toEqual({
      speaker: 'Dana',
      words: [
        { text: 'Hi', start: 1.5, end: 1.9 },
        { text: 'there', start: 2.0, end: 2.4 },
      ],
    });
    expect(segs[1]!.speaker).toBe('Sam');
    expect(segs[1]!.words[0]).toEqual({ text: 'Yo', start: null, end: null });
  });

  it('getTranscript unwraps { results } / { transcript } and rejects a non-list body', async () => {
    const wrapped = new HttpRecallClient(
      opts(stubFetch({ json: { results: [{ speaker: 'A', words: [{ text: 'hi' }] }] } }).impl),
    );
    expect((await wrapped.getTranscript('b'))[0]!.speaker).toBe('A');

    const malformed = new HttpRecallClient(opts(stubFetch({ json: { detail: 'oops' } }).impl));
    await expect(malformed.getTranscript('b')).rejects.toBeInstanceOf(RecallApiError);
  });

  it('raises RecallApiError on a non-2xx response', async () => {
    const client = new HttpRecallClient(
      opts(stubFetch({ status: 404, text: '{"detail":"Not found."}' }).impl),
    );
    await expect(client.getBot('missing')).rejects.toBeInstanceOf(RecallApiError);
  });

  it('rejects construction without an api key', () => {
    expect(() => new HttpRecallClient({ apiKey: '' })).toThrow(/apiKey is required/);
  });
});
