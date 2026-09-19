import {
  DEFAULT_GITHUB_API_URL,
  GitHubApiError,
  type GitHubClient,
  type GitHubPage,
  type GitHubPullRequest,
  type GitHubRepository,
  type GitHubUser,
  type ListPullRequestsOptions,
} from './github-client.js';

export interface HttpGitHubClientOptions {
  /** OAuth access token from Nango (`NangoConnection.accessToken`) — sent as the bearer */
  accessToken: string;
  /** the bound repo, `owner/repo` */
  repoFullName: string;
  /** REST API base, no trailing slash (default `DEFAULT_GITHUB_API_URL`) */
  apiUrl?: string;
  /** injectable for tests; defaults to global `fetch` */
  fetchImpl?: typeof fetch;
  /** PRs fetched per REST page (default 30, GitHub's own default) */
  pageSize?: number;
}

// --- GitHub REST shapes (kept private to this module) --------------------------

interface GhUser {
  id?: number | null;
  login?: string | null;
}

interface GhRef {
  ref?: string | null;
}

interface GhPull {
  id?: number | null;
  number?: number | null;
  title?: string | null;
  body?: string | null;
  state?: string | null;
  merged_at?: string | null;
  html_url?: string | null;
  base?: GhRef | null;
  head?: GhRef | null;
  created_at?: string | null;
  updated_at?: string | null;
  user?: GhUser | null;
  requested_reviewers?: GhUser[] | null;
}

interface GhReview {
  user?: GhUser | null;
}

interface GhRepo {
  id?: number | null;
  full_name?: string | null;
  private?: boolean | null;
}

function toUser(u: GhUser | null | undefined): GitHubUser | null {
  if (u?.id === undefined || u?.id === null) return null;
  return { id: String(u.id), login: u.login ?? '', name: null, email: null };
}

/** The `page` query param of a `Link: <url>; rel="next"` entry, or null if there isn't one. */
function nextPageFromLinkHeader(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(',')) {
    const match = /<([^>]+)>;\s*rel="next"/.exec(part);
    if (!match) continue;
    try {
      return new URL(match[1]!).searchParams.get('page');
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Real GitHub client — REST v3 over `https://api.github.com` with the
 * Nango-minted OAuth token as the bearer. Untested against the live API until
 * a GitHub integration is configured in Nango — exercised only by
 * `github-client.smoke.test.ts` (`describe.skipIf(!GITHUB_SMOKE_TOKEN)`).
 * Everything above `GitHubClient` runs on `FakeGitHubClient`.
 */
export class HttpGitHubClient implements GitHubClient {
  private readonly accessToken: string;
  private readonly repoFullName: string;
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pageSize: number;

  constructor(options: HttpGitHubClientOptions) {
    if (!options.accessToken) throw new Error('HttpGitHubClient: accessToken is required');
    if (!options.repoFullName) throw new Error('HttpGitHubClient: repoFullName is required');
    this.accessToken = options.accessToken;
    this.repoFullName = options.repoFullName;
    this.apiUrl = (options.apiUrl ?? DEFAULT_GITHUB_API_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pageSize = options.pageSize ?? 30;
  }

  private async rest<T>(
    path: string,
    searchParams?: Record<string, string>,
  ): Promise<{ body: T; nextPage: string | null }> {
    const url = new URL(`${this.apiUrl}${path}`);
    for (const [k, v] of Object.entries(searchParams ?? {})) url.searchParams.set(k, v);
    const res = await this.fetchImpl(url, {
      headers: {
        authorization: `Bearer ${this.accessToken}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new GitHubApiError(res.status, detail.slice(0, 500));
    }
    const body = (await res.json()) as T;
    return { body, nextPage: nextPageFromLinkHeader(res.headers.get('link')) };
  }

  private repoParts(): [string, string] {
    const [owner, repo] = this.repoFullName.split('/');
    if (!owner || !repo) {
      throw new Error(
        `HttpGitHubClient: repoFullName must be 'owner/repo', got '${this.repoFullName}'`,
      );
    }
    return [owner, repo];
  }

  async listRepository(): Promise<GitHubRepository> {
    const [owner, repo] = this.repoParts();
    const { body: repoBody } = await this.rest<GhRepo>(`/repos/${owner}/${repo}`);

    // Best-effort: listing collaborators needs push/admin access to the repo.
    // A 403 (token lacks that scope) is an unresolvable ACL, not a fatal
    // error — `GitHubConnector.resolveAcl` treats an empty list the same as
    // `LinearConnector` treats an empty workspace membership.
    let collaboratorIds: string[] = [];
    try {
      const { body: collaborators } = await this.rest<GhUser[]>(
        `/repos/${owner}/${repo}/collaborators`,
        { per_page: '100' },
      );
      collaboratorIds = collaborators.filter((u) => u.id != null).map((u) => String(u.id));
    } catch {
      collaboratorIds = [];
    }

    return {
      id: String(repoBody.id ?? ''),
      fullName: repoBody.full_name ?? this.repoFullName,
      private: repoBody.private ?? true,
      collaboratorIds,
    };
  }

  /**
   * Distinct users who submitted at least one review on a PR, deduped by id.
   * `/pulls` (unlike `/pulls/{n}`) never embeds reviews, so this is one extra
   * request per PR — acceptable for v1's PR-level-state scope (no inline
   * review comments, no per-review detail; see `GitHubConnector`'s header
   * comment).
   */
  private async completedReviewers(
    owner: string,
    repo: string,
    number: number,
  ): Promise<GitHubUser[]> {
    if (!number) return [];
    const { body: reviews } = await this.rest<GhReview[]>(
      `/repos/${owner}/${repo}/pulls/${number}/reviews`,
    );
    const seen = new Map<string, GitHubUser>();
    for (const r of reviews) {
      const u = toUser(r.user);
      if (u && !seen.has(u.id)) seen.set(u.id, u);
    }
    return [...seen.values()];
  }

  async listPullRequests(
    options: ListPullRequestsOptions = {},
  ): Promise<GitHubPage<GitHubPullRequest>> {
    const [owner, repo] = this.repoParts();
    const { body: pulls, nextPage } = await this.rest<GhPull[]>(`/repos/${owner}/${repo}/pulls`, {
      state: 'all',
      sort: 'updated',
      direction: 'asc',
      per_page: String(options.limit ?? this.pageSize),
      page: options.cursor ?? '1',
    });

    const items: GitHubPullRequest[] = [];
    for (const p of pulls) {
      const updatedAt = p.updated_at ?? new Date(0).toISOString();
      // `/repos/{o}/{r}/pulls` has no server-side `since` filter (unlike
      // `/issues`) — filtered client-side. Ascending order means once a page
      // clears the threshold every later page does too, but earlier pages
      // still cost a round trip; a documented v1 inefficiency for large repos.
      if (options.updatedSince && updatedAt < options.updatedSince) continue;
      const number = p.number ?? 0;
      items.push({
        id: String(p.id ?? ''),
        number,
        title: p.title ?? '',
        body: p.body ?? null,
        state: p.state === 'closed' ? 'closed' : 'open',
        merged: p.merged_at != null,
        url: p.html_url ?? '',
        baseRef: p.base?.ref ?? '',
        headRef: p.head?.ref ?? '',
        createdAt: p.created_at ?? updatedAt,
        updatedAt,
        author: toUser(p.user),
        requestedReviewers: (p.requested_reviewers ?? [])
          .map(toUser)
          .filter((u): u is GitHubUser => u !== null),
        completedReviewers: await this.completedReviewers(owner, repo, number),
      });
    }
    return { items, nextCursor: nextPage };
  }
}
