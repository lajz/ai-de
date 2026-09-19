/**
 * The seam over GitHub (https://github.com) — a Nango-backed connector: the
 * bearer token `HttpGitHubClient` sends is a **fresh OAuth access token minted
 * by self-hosted Nango** (`NangoClient.getConnection`), never a token this
 * platform stores. Mirrors `../linear/linear-client.ts` — see that file's
 * header comment for the Nango custody model.
 *
 * `HttpGitHubClient` speaks GitHub's REST API (v3, `application/vnd.github+json`);
 * `FakeGitHubClient` is a deterministic in-memory corpus the connector logic +
 * its tests run against. GitHub's wire shapes stay inside `HttpGitHubClient`;
 * everything above this interface sees only the normalized types below.
 *
 * One connection is scoped to exactly one repo (`owner/repo`) — see
 * `GitHubConnector`'s header comment for how the connector learns which one.
 */

/** A GitHub user attached to a pull request (author / reviewer). */
export interface GitHubUser {
  /** GitHub's stable numeric user id, as a string */
  id: string;
  login: string;
  /**
   * GitHub's PR / review APIs only ever embed `id` + `login` on actor objects
   * — a display name or public email needs a separate `GET /users/{login}`
   * call. v1 skips that extra round trip (one more API call per distinct
   * person, per sync) and identifies GitHub people by their login; always
   * `null` here. A documented follow-up, not a data-loss bug: `normalize`
   * falls back to `login` for `displayName`, same as Linear falls back to
   * `id` when a user has no name.
   */
  name: string | null;
  email: string | null;
}

/** One GitHub pull request, normalized. */
export interface GitHubPullRequest {
  /** GitHub's stable PR database id, as a string — stable across retitles/force-pushes */
  id: string;
  /** the repo-scoped PR number, e.g. `42` (human-facing, not globally unique) */
  number: number;
  title: string;
  /** markdown PR description; the decision-link marker (if any) lives here */
  body: string | null;
  state: 'open' | 'closed';
  /** true once merged — GitHub reports this via `merged_at`, not `state` */
  merged: boolean;
  /** deep link into GitHub */
  url: string;
  baseRef: string;
  headRef: string;
  /** ISO-8601 */
  createdAt: string;
  /** ISO-8601 — the incremental-sync ordering + cursor key */
  updatedAt: string;
  author: GitHubUser | null;
  /** reviewers still awaiting a review */
  requestedReviewers: GitHubUser[];
  /** distinct users who have submitted at least one review (any state), deduped */
  completedReviewers: GitHubUser[];
}

/** The bound repository — the tenancy + access-control boundary for this connector. */
export interface GitHubRepository {
  id: string;
  /** `owner/repo` */
  fullName: string;
  private: boolean;
  /**
   * Collaborator ids — best-effort. Populated only when the token has
   * sufficient scope to list them (private repos need push/admin access);
   * empty when unresolvable, mirroring `LinearWorkspace.memberIds` being
   * empty when workspace membership can't be read.
   */
  collaboratorIds: string[];
}

/** One page of a listing plus the opaque cursor for the next page (null = last page). */
export interface GitHubPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ListPullRequestsOptions {
  /** only PRs updated at/after this ISO-8601 instant (inclusive) */
  updatedSince?: string;
  /** page cursor from a previous `GitHubPage.nextCursor` */
  cursor?: string;
  /** page size hint */
  limit?: number;
}

export interface GitHubClient {
  /** The repo this client is bound to, with its access-control snapshot. */
  listRepository(): Promise<GitHubRepository>;
  /**
   * One page of pull requests, **ordered by `updated_at` ascending**
   * (`sort=updated&direction=asc` — GitHub, unlike Linear, supports ascending
   * order on this endpoint) so a sync can checkpoint per page instead of only
   * at the end. See `GitHubConnector`'s `stream` for why that's safe.
   */
  listPullRequests(options?: ListPullRequestsOptions): Promise<GitHubPage<GitHubPullRequest>>;
}

/** Raised by `HttpGitHubClient` for a non-2xx REST response. Carries no PR content. */
export class GitHubApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`GitHub API → ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'GitHubApiError';
  }
}

/** `sources.connector` value + `Connector.id` for GitHub-ingested artifacts. */
export const GITHUB_CONNECTOR = 'github';

/** Nango integration id for GitHub, by convention equal to the connector id. */
export const GITHUB_PROVIDER_CONFIG_KEY = 'github';

/** How long a GitHub repo-collaborator ACL snapshot may be trusted before a refresh. */
export const GITHUB_ACL_TTL_SECONDS = 3600;

/** GitHub's REST API base. Override with `GITHUB_API_URL` (e.g. for GitHub Enterprise Server). */
export const DEFAULT_GITHUB_API_URL = 'https://api.github.com';

/** Header GitHub signs webhook payloads with (`sha256=<hex>`, HMAC-SHA256 over the raw body). */
export const GITHUB_WEBHOOK_SIGNATURE_HEADER = 'x-hub-signature-256';

/** Header naming the webhook event type, e.g. `pull_request`. */
export const GITHUB_EVENT_HEADER = 'x-github-event';
