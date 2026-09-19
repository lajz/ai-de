import { describe, expect, it } from 'vitest';

import { FakeGitHubClient } from './fake-github-client.js';
import { GitHubApiError } from './github-client.js';
import { HttpGitHubClient } from './http-github-client.js';

describe('FakeGitHubClient', () => {
  it('paginates PRs oldest-updated-first and terminates', async () => {
    const client = new FakeGitHubClient({ pageSize: 2 });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await client.listPullRequests({ cursor });
      seen.push(...page.items.map((p) => p.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toEqual(['pr-1', 'pr-2', 'pr-3']);
  });

  it('filters by updatedSince (inclusive)', async () => {
    const page = await new FakeGitHubClient({ pageSize: 10 }).listPullRequests({
      updatedSince: '2026-09-02T09:00:00.000Z',
    });
    expect(page.items.map((p) => p.id)).toEqual(['pr-2', 'pr-3']);
  });

  it('serves the bound repo', async () => {
    const repo = await new FakeGitHubClient().listRepository();
    expect(repo).toMatchObject({ fullName: 'acme/orion', private: true });
  });

  it('honors an overridden repoFullName', async () => {
    const repo = await new FakeGitHubClient({ repoFullName: 'acme/other' }).listRepository();
    expect(repo.fullName).toBe('acme/other');
  });
});

/** Minimal fetch stub — routes on the URL path, records requests, returns canned JSON + Link headers. */
function stubFetch(
  handler: (url: URL) => { status?: number; json?: unknown; link?: string; text?: string },
) {
  const calls: Array<{ url: URL }> = [];
  const impl = (async (url: string | URL) => {
    const u = url instanceof URL ? url : new URL(String(url));
    calls.push({ url: u });
    const response = handler(u);
    const status = response.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => (name === 'link' ? (response.link ?? null) : null) },
      json: async () => response.json,
      text: async () => response.text ?? JSON.stringify(response.json ?? ''),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('HttpGitHubClient', () => {
  const opts = (fetchImpl: typeof fetch) => ({
    accessToken: 'gho_tok',
    repoFullName: 'acme/orion',
    fetchImpl,
  });

  it('rejects construction without an access token or a repo', () => {
    expect(() => new HttpGitHubClient({ accessToken: '', repoFullName: 'acme/orion' })).toThrow(
      /accessToken is required/,
    );
    expect(() => new HttpGitHubClient({ accessToken: 'tok', repoFullName: '' })).toThrow(
      /repoFullName is required/,
    );
  });

  it('listPullRequests sends the token, state=all + ascending sort, paginates via Link, and fetches completed reviewers', async () => {
    const { impl, calls } = stubFetch((url) => {
      if (url.pathname.endsWith('/reviews')) {
        return { json: [{ user: { id: 9, login: 'carol' } }, { user: { id: 9, login: 'carol' } }] };
      }
      if (url.pathname.endsWith('/pulls')) {
        return {
          json: [
            {
              id: 1,
              number: 42,
              title: 'Do the thing',
              body: 'body',
              state: 'open',
              merged_at: null,
              html_url: 'https://github.com/acme/orion/pull/42',
              base: { ref: 'main' },
              head: { ref: 'feature' },
              created_at: '2026-09-01T00:00:00.000Z',
              updated_at: '2026-09-01T01:00:00.000Z',
              user: { id: 1, login: 'ann' },
              requested_reviewers: [{ id: 2, login: 'bo' }],
            },
          ],
          link: '<https://api.github.com/repos/acme/orion/pulls?page=2>; rel="next"',
        };
      }
      throw new Error(`unexpected path ${url.pathname}`);
    });

    const page = await new HttpGitHubClient(opts(impl)).listPullRequests({ cursor: '1' });
    expect(page.nextCursor).toBe('2');
    expect(page.items[0]).toMatchObject({
      id: '1',
      number: 42,
      state: 'open',
      merged: false,
      author: { id: '1', login: 'ann' },
      requestedReviewers: [{ id: '2', login: 'bo' }],
      completedReviewers: [{ id: '9', login: 'carol' }],
    });

    const pullsCall = calls.find((c) => c.url.pathname.endsWith('/pulls'))!;
    expect(pullsCall.url.searchParams.get('state')).toBe('all');
    expect(pullsCall.url.searchParams.get('sort')).toBe('updated');
    expect(pullsCall.url.searchParams.get('direction')).toBe('asc');
    expect(pullsCall.url.searchParams.get('page')).toBe('1');
  });

  it('merged is true once merged_at is set, regardless of state', async () => {
    const { impl } = stubFetch((url) => {
      if (url.pathname.endsWith('/reviews')) return { json: [] };
      return {
        json: [
          {
            id: 2,
            number: 5,
            title: 'Merged PR',
            state: 'closed',
            merged_at: '2026-09-02T00:00:00.000Z',
            updated_at: '2026-09-02T00:00:00.000Z',
          },
        ],
      };
    });
    const page = await new HttpGitHubClient(opts(impl)).listPullRequests();
    expect(page.items[0]).toMatchObject({ state: 'closed', merged: true });
  });

  it('filters client-side by updatedSince', async () => {
    const { impl } = stubFetch((url) => {
      if (url.pathname.endsWith('/reviews')) return { json: [] };
      return {
        json: [
          { id: 1, number: 1, updated_at: '2026-09-01T00:00:00.000Z' },
          { id: 2, number: 2, updated_at: '2026-09-03T00:00:00.000Z' },
        ],
      };
    });
    const page = await new HttpGitHubClient(opts(impl)).listPullRequests({
      updatedSince: '2026-09-02T00:00:00.000Z',
    });
    expect(page.items.map((p) => p.id)).toEqual(['2']);
  });

  it('listRepository reads private + collaborators, and tolerates a 403 on collaborators', async () => {
    const { impl } = stubFetch((url) => {
      if (url.pathname.endsWith('/collaborators')) return { status: 403, text: 'forbidden' };
      return { json: { id: 7, full_name: 'acme/orion', private: true } };
    });
    const repo = await new HttpGitHubClient(opts(impl)).listRepository();
    expect(repo).toEqual({ id: '7', fullName: 'acme/orion', private: true, collaboratorIds: [] });
  });

  it('listRepository collects collaborator ids when resolvable', async () => {
    const { impl } = stubFetch((url) => {
      if (url.pathname.endsWith('/collaborators')) {
        return {
          json: [
            { id: 1, login: 'ann' },
            { id: 2, login: 'bo' },
          ],
        };
      }
      return { json: { id: 7, full_name: 'acme/orion', private: true } };
    });
    const repo = await new HttpGitHubClient(opts(impl)).listRepository();
    expect(repo.collaboratorIds).toEqual(['1', '2']);
  });

  it('raises GitHubApiError on a non-2xx response', async () => {
    const { impl } = stubFetch(() => ({ status: 401, text: 'unauthorized' }));
    await expect(new HttpGitHubClient(opts(impl)).listRepository()).rejects.toBeInstanceOf(
      GitHubApiError,
    );
  });
});
