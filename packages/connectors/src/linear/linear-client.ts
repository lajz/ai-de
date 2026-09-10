/**
 * The seam over Linear (https://linear.app) — a Nango-backed connector: the
 * bearer token `HttpLinearClient` sends is a **fresh OAuth access token minted
 * by self-hosted Nango** (`NangoClient.getConnection`), never a token this
 * platform stores. `docs/architecture.md`: "Connector strategy" — Nango-backed
 * (self-hosted) for Linear.
 *
 * `HttpLinearClient` speaks Linear's GraphQL API; `FakeLinearClient` is a
 * deterministic in-memory corpus the connector logic + its tests run against.
 * Linear's wire shapes (GraphQL envelopes, connection/edge pagination) stay
 * inside `HttpLinearClient`; everything above this interface sees only the
 * normalized types below.
 */

/** A Linear user attached to an issue (assignee / creator). */
export interface LinearUser {
  /** Linear's stable user id */
  id: string;
  name: string | null;
  email: string | null;
}

/** One Linear issue, normalized. */
export interface LinearIssue {
  id: string;
  /** human-facing key, e.g. `ENG-42` */
  identifier: string;
  title: string;
  /** markdown issue description; the decision-link marker (if any) lives here */
  description: string | null;
  /** workflow state name, e.g. `In Progress`, `Done` */
  state: string;
  /** deep link into Linear */
  url: string;
  /** ISO-8601 */
  createdAt: string;
  /** ISO-8601 — the incremental-sync ordering + cursor key */
  updatedAt: string;
  assignee: LinearUser | null;
  creator: LinearUser | null;
  /** e.g. `Urgent`, `High`; null when unset */
  priorityLabel: string | null;
  /** the owning team's key, e.g. `ENG` */
  teamKey: string | null;
}

/** The Linear workspace (organization) — the tenancy + membership boundary. */
export interface LinearWorkspace {
  id: string;
  name: string;
  /** ids of the workspace's active members — the basis for the source ACL */
  memberIds: string[];
}

/** One page of a listing plus the opaque cursor for the next page (null = last page). */
export interface LinearPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ListIssuesOptions {
  /** only issues updated at/after this ISO-8601 instant (inclusive) */
  updatedSince?: string;
  /** page cursor from a previous `LinearPage.nextCursor` */
  cursor?: string;
  /** page size hint */
  limit?: number;
}

export interface LinearClient {
  /** The workspace (organization) the token can see, with its active members. */
  listWorkspace(): Promise<LinearWorkspace>;
  /**
   * One page of issues, **ordered by `updatedAt` ascending** so a sync can
   * checkpoint on the last item's `updatedAt` and resume from there.
   */
  listIssues(options?: ListIssuesOptions): Promise<LinearPage<LinearIssue>>;
}

/** Raised by `HttpLinearClient` for a GraphQL error or non-2xx response. Carries no issue content. */
export class LinearApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(`Linear API → ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'LinearApiError';
  }
}

/** `sources.connector` value + `Connector.id` for Linear-ingested artifacts. */
export const LINEAR_CONNECTOR = 'linear';

/** Nango integration id for Linear, by convention equal to the connector id. */
export const LINEAR_PROVIDER_CONFIG_KEY = 'linear';

/** How long a Linear workspace-membership ACL snapshot may be trusted before a refresh. */
export const LINEAR_ACL_TTL_SECONDS = 3600;

/** Linear's GraphQL endpoint. Override with `LINEAR_API_URL`. */
export const DEFAULT_LINEAR_API_URL = 'https://api.linear.app/graphql';

/** Header Linear signs webhook payloads with (HMAC-SHA256 hex over the raw body). */
export const LINEAR_WEBHOOK_SIGNATURE_HEADER = 'linear-signature';
