import { describe, expect, it } from 'vitest';

import { FakeLinearClient } from './fake-linear-client.js';
import { LinearApiError } from './linear-client.js';
import { HttpLinearClient } from './http-linear-client.js';

describe('FakeLinearClient', () => {
  it('paginates issues newest-first and terminates', async () => {
    const client = new FakeLinearClient({ pageSize: 2 });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listIssues({ cursor });
      seen.push(...page.items.map((i) => i.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(['iss-3', 'iss-2', 'iss-1']);
  });

  it('filters by updatedSince (inclusive)', async () => {
    const page = await new FakeLinearClient({ pageSize: 10 }).listIssues({
      updatedSince: '2026-09-02T09:30:00.000Z',
    });
    expect(page.items.map((i) => i.id)).toEqual(['iss-3', 'iss-2']);
  });

  it('serves the workspace + its members', async () => {
    const ws = await new FakeLinearClient().listWorkspace();
    expect(ws).toMatchObject({ id: 'org-acme', memberIds: ['lu-alice', 'lu-bob'] });
  });
});

/** Minimal fetch stub — records requests, returns a canned GraphQL response. */
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

describe('HttpLinearClient', () => {
  const opts = (fetchImpl: typeof fetch) => ({ accessToken: 'lin_oauth_tok', fetchImpl });

  it('rejects construction without an access token', () => {
    expect(() => new HttpLinearClient({ accessToken: '' })).toThrow(/accessToken is required/);
  });

  it('listIssues sends the token, an updatedAt filter + cursor, and normalizes the nodes', async () => {
    const { impl, calls } = stubFetch({
      json: {
        data: {
          issues: {
            nodes: [
              {
                id: 'i1',
                identifier: 'ENG-1',
                title: 'Do the thing',
                description: 'body',
                url: 'https://linear.app/x/issue/ENG-1',
                createdAt: '2026-09-01T00:00:00.000Z',
                updatedAt: '2026-09-01T01:00:00.000Z',
                priorityLabel: 'High',
                state: { name: 'In Progress' },
                team: { key: 'ENG' },
                assignee: { id: 'u1', name: 'Ann', email: 'ann@x.example' },
                creator: { id: 'u2', name: 'Bo', email: null },
              },
            ],
            pageInfo: { hasNextPage: true, endCursor: 'c2' },
          },
        },
      },
    });
    const page = await new HttpLinearClient(opts(impl)).listIssues({
      updatedSince: '2026-09-01T00:00:00.000Z',
      cursor: 'c1',
    });
    expect(page.nextCursor).toBe('c2');
    expect(page.items[0]).toMatchObject({
      id: 'i1',
      identifier: 'ENG-1',
      state: 'In Progress',
      teamKey: 'ENG',
      assignee: { id: 'u1', email: 'ann@x.example' },
      creator: { id: 'u2', email: null },
    });
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(
      'Bearer lin_oauth_tok',
    );
    const body = JSON.parse(calls[0]!.init.body as string);
    expect(body.variables).toMatchObject({
      after: 'c1',
      filter: { updatedAt: { gte: '2026-09-01T00:00:00.000Z' } },
    });
  });

  it('listWorkspace pages through active members', async () => {
    let call = 0;
    const impl = (async () => {
      call += 1;
      const body =
        call === 1
          ? {
              data: {
                organization: { id: 'org-1', name: 'Org' },
                users: { nodes: [{ id: 'm1' }], pageInfo: { hasNextPage: true, endCursor: 'p2' } },
              },
            }
          : {
              data: {
                organization: { id: 'org-1', name: 'Org' },
                users: { nodes: [{ id: 'm2' }], pageInfo: { hasNextPage: false, endCursor: null } },
              },
            };
      return { ok: true, status: 200, json: async () => body, text: async () => '' } as Response;
    }) as unknown as typeof fetch;
    const ws = await new HttpLinearClient(opts(impl)).listWorkspace();
    expect(ws).toEqual({ id: 'org-1', name: 'Org', memberIds: ['m1', 'm2'] });
  });

  it('raises LinearApiError on a GraphQL error payload', async () => {
    const { impl } = stubFetch({ json: { errors: [{ message: 'bad token' }] } });
    await expect(new HttpLinearClient(opts(impl)).listIssues()).rejects.toBeInstanceOf(
      LinearApiError,
    );
  });

  it('raises LinearApiError on a non-2xx response', async () => {
    const { impl } = stubFetch({ status: 401, text: 'unauthorized' });
    await expect(new HttpLinearClient(opts(impl)).listIssues()).rejects.toBeInstanceOf(
      LinearApiError,
    );
  });
});
