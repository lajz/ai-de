import { describe, expect, it } from 'vitest';

import { FakeGranolaClient } from './fake-granola-client.js';
import { GranolaApiError } from './granola-client.js';
import { HttpGranolaClient } from './http-granola-client.js';

describe('FakeGranolaClient', () => {
  it('paginates documents in updatedAt order and terminates', async () => {
    const client = new FakeGranolaClient({ pageSize: 2 });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listDocuments({ cursor });
      seen.push(...page.items.map((d) => d.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(['doc-standup', 'doc-brief', 'doc-ext']);
  });

  it('filters by updatedSince (inclusive)', async () => {
    const client = new FakeGranolaClient({ pageSize: 10 });
    const page = await client.listDocuments({ updatedSince: '2026-09-02T09:30:00.000Z' });
    expect(page.items.map((d) => d.id)).toEqual(['doc-brief', 'doc-ext']);
  });

  it('serves transcripts + bodies and records transcript fetches', async () => {
    const client = new FakeGranolaClient();
    expect((await client.getTranscript('doc-standup')).segments[0]?.text).toContain('Welcome');
    expect((await client.getDocumentBody('doc-brief')).notes).toContain('Orion brief');
    expect(client.transcriptFetches).toEqual(['doc-standup']);
  });
});

/** Minimal fetch stub — records requests, returns a canned response. */
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

describe('HttpGranolaClient', () => {
  const opts = (fetchImpl: typeof fetch) => ({
    apiKey: 'grn_test',
    baseUrl: 'https://api.granola.ai',
    fetchImpl,
  });

  it('rejects construction without an api key', () => {
    expect(() => new HttpGranolaClient({ apiKey: '' })).toThrow(/apiKey is required/);
  });

  it('listWorkspaces sends a Bearer token and flattens membership', async () => {
    const { impl, calls } = stubFetch({
      json: {
        workspaces: [
          { id: 'ws-1', display_name: 'One', members: [{ user_id: 'u1' }, { id: 'u2' }, {}] },
        ],
      },
    });
    const res = await new HttpGranolaClient(opts(impl)).listWorkspaces();
    expect(res).toEqual([{ id: 'ws-1', name: 'One', memberIds: ['u1', 'u2'] }]);
    expect(calls[0]!.url).toBe('https://api.granola.ai/v1/workspaces');
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer grn_test',
    );
  });

  it('listDocuments requests ascending updatedAt order + passes the cursor', async () => {
    const { impl, calls } = stubFetch({
      json: {
        documents: [
          {
            id: 'd1',
            workspace_id: 'ws-1',
            title: 'Sync',
            updated_at: '2026-09-01T00:00:00.000Z',
            transcript_id: 't1',
            people: [{ id: 'p1', name: 'Pat', email: 'pat@x.example' }],
            deeplink: 'https://granola.ai/d/d1',
          },
        ],
        next_cursor: 'c2',
      },
    });
    const page = await new HttpGranolaClient(opts(impl)).listDocuments({
      updatedSince: '2026-09-01T00:00:00.000Z',
      cursor: 'c1',
    });
    expect(page.nextCursor).toBe('c2');
    expect(page.items[0]).toMatchObject({
      id: 'd1',
      hasTranscript: true,
      url: 'https://granola.ai/d/d1',
    });
    const url = new URL(calls[0]!.url);
    expect(url.searchParams.get('order')).toBe('asc');
    expect(url.searchParams.get('updated_since')).toBe('2026-09-01T00:00:00.000Z');
    expect(url.searchParams.get('cursor')).toBe('c1');
  });

  it('getTranscript normalizes speaker + timestamp shapes', async () => {
    const { impl } = stubFetch({
      json: {
        segments: [
          { speaker: 'Dana', text: ' Hi ', start_seconds: 1.5 },
          { speaker_name: 'Sam', text: 'Yo', start: 2 },
        ],
      },
    });
    const t = await new HttpGranolaClient(opts(impl)).getTranscript('d1');
    expect(t.segments).toEqual([
      { speaker: 'Dana', text: 'Hi', start: 1.5 },
      { speaker: 'Sam', text: 'Yo', start: 2 },
    ]);
  });

  it('raises GranolaApiError on a non-2xx response', async () => {
    const { impl } = stubFetch({ status: 401, text: '{"error":"bad token"}' });
    await expect(new HttpGranolaClient(opts(impl)).listWorkspaces()).rejects.toBeInstanceOf(
      GranolaApiError,
    );
  });
});
