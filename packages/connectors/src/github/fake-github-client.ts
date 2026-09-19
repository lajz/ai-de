import {
  type GitHubClient,
  type GitHubPage,
  type GitHubPullRequest,
  type GitHubRepository,
  type ListPullRequestsOptions,
} from './github-client.js';

/** A fixed repo + three-PR corpus — deterministic content for the connector logic + tests. */
export const FAKE_GITHUB_REPOSITORY: GitHubRepository = {
  id: 'repo-orion',
  fullName: 'acme/orion',
  private: true,
  collaboratorIds: ['gh-alice', 'gh-bob'],
};

export const FAKE_GITHUB_PULL_REQUESTS: GitHubPullRequest[] = [
  {
    id: 'pr-1',
    number: 101,
    title: 'Ship the Orion API',
    // carries a decision-link marker — see `extractDecisionRefs`
    body: 'Implements the Friday ship decision.\n\nfde:decision:dec-orion-ship',
    state: 'closed',
    merged: true,
    url: 'https://github.com/acme/orion/pull/101',
    baseRef: 'main',
    headRef: 'ship-orion',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
    author: { id: 'gh-alice', login: 'alice', name: null, email: null },
    requestedReviewers: [],
    completedReviewers: [{ id: 'gh-bob', login: 'bob', name: null, email: null }],
  },
  {
    id: 'pr-2',
    number: 102,
    title: 'Write the migration guide',
    body: null,
    state: 'open',
    merged: false,
    url: 'https://github.com/acme/orion/pull/102',
    baseRef: 'main',
    headRef: 'migration-guide',
    createdAt: '2026-09-02T09:00:00.000Z',
    updatedAt: '2026-09-02T09:30:00.000Z',
    author: { id: 'gh-bob', login: 'bob', name: null, email: null },
    requestedReviewers: [{ id: 'gh-alice', login: 'alice', name: null, email: null }],
    completedReviewers: [],
  },
  {
    id: 'pr-3',
    number: 103,
    title: 'Unreviewed cleanup PR',
    body: 'No reviewers yet.',
    state: 'open',
    merged: false,
    url: 'https://github.com/acme/orion/pull/103',
    baseRef: 'main',
    headRef: 'cleanup',
    createdAt: '2026-09-03T08:00:00.000Z',
    updatedAt: '2026-09-03T08:15:00.000Z',
    author: { id: 'gh-alice', login: 'alice', name: null, email: null },
    requestedReviewers: [],
    completedReviewers: [],
  },
];

export interface FakeGitHubOptions {
  /** overrides `FAKE_GITHUB_REPOSITORY.fullName` — what `loadGitHubClientFactory`'s fake branch passes */
  repoFullName?: string;
  repository?: GitHubRepository;
  pullRequests?: GitHubPullRequest[];
  /** page size the fake paginates at (default 2 — exercises multi-page + checkpointing) */
  pageSize?: number;
}

/**
 * Dependency-free `GitHubClient`. No network: PRs are served **oldest-updated-
 * first** (GitHub's `sort=updated&direction=asc` order — the opposite of
 * `FakeLinearClient`, which mirrors Linear's newest-first order), paginated so
 * a sync run crosses page boundaries.
 */
export class FakeGitHubClient implements GitHubClient {
  private readonly repository: GitHubRepository;
  private readonly pullRequests: GitHubPullRequest[];
  private readonly pageSize: number;

  constructor(options: FakeGitHubOptions = {}) {
    this.repository =
      options.repository ??
      (options.repoFullName
        ? { ...FAKE_GITHUB_REPOSITORY, fullName: options.repoFullName }
        : FAKE_GITHUB_REPOSITORY);
    // ascending by updatedAt — matches GitHub's `sort=updated&direction=asc`
    this.pullRequests = [...(options.pullRequests ?? FAKE_GITHUB_PULL_REQUESTS)].sort(
      (a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id),
    );
    this.pageSize = options.pageSize ?? 2;
  }

  async listRepository(): Promise<GitHubRepository> {
    return { ...this.repository, collaboratorIds: [...this.repository.collaboratorIds] };
  }

  async listPullRequests(
    options: ListPullRequestsOptions = {},
  ): Promise<GitHubPage<GitHubPullRequest>> {
    const filtered = options.updatedSince
      ? this.pullRequests.filter((p) => p.updatedAt >= options.updatedSince!)
      : this.pullRequests;
    const start = options.cursor ? Number(options.cursor) : 0;
    const size = options.limit ?? this.pageSize;
    const slice = filtered.slice(start, start + size);
    const next = start + size < filtered.length ? String(start + size) : null;
    return { items: slice.map((p) => structuredClone(p)), nextCursor: next };
  }
}
