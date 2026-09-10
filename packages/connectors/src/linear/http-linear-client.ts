import {
  DEFAULT_LINEAR_API_URL,
  LinearApiError,
  type LinearClient,
  type LinearIssue,
  type LinearPage,
  type LinearUser,
  type LinearWorkspace,
  type ListIssuesOptions,
} from './linear-client.js';

export interface HttpLinearClientOptions {
  /** OAuth access token from Nango (`NangoConnection.accessToken`) — sent as the bearer */
  accessToken: string;
  /** GraphQL endpoint, no trailing slash (default `DEFAULT_LINEAR_API_URL`) */
  apiUrl?: string;
  /** injectable for tests; defaults to global `fetch` */
  fetchImpl?: typeof fetch;
  /** issues fetched per GraphQL page (default 50) */
  pageSize?: number;
}

// --- Linear GraphQL shapes (kept private to this module) ----------------------

interface GqlUser {
  id?: string | null;
  name?: string | null;
  email?: string | null;
}

interface GqlIssue {
  id?: string | null;
  identifier?: string | null;
  title?: string | null;
  description?: string | null;
  url?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  priorityLabel?: string | null;
  state?: { name?: string | null } | null;
  team?: { key?: string | null } | null;
  assignee?: GqlUser | null;
  creator?: GqlUser | null;
}

interface GqlPageInfo {
  hasNextPage?: boolean;
  endCursor?: string | null;
}

interface GqlResponse<T> {
  data?: T | null;
  errors?: Array<{ message?: string }> | null;
}

const ISSUE_FIELDS = `
  id
  identifier
  title
  description
  url
  createdAt
  updatedAt
  priorityLabel
  state { name }
  team { key }
  assignee { id name email }
  creator { id name email }
`;

const ISSUES_QUERY = `
query Issues($after: String, $first: Int, $filter: IssueFilter) {
  issues(after: $after, first: $first, filter: $filter, orderBy: updatedAt) {
    nodes {${ISSUE_FIELDS}}
    pageInfo { hasNextPage endCursor }
  }
}`;

const WORKSPACE_QUERY = `
query Workspace($after: String) {
  organization { id name }
  users(first: 250, after: $after, filter: { active: { eq: true } }) {
    nodes { id }
    pageInfo { hasNextPage endCursor }
  }
}`;

function toUser(u: GqlUser | null | undefined): LinearUser | null {
  if (!u?.id) return null;
  return { id: u.id, name: u.name ?? null, email: u.email ?? null };
}

function toIssue(n: GqlIssue): LinearIssue {
  const now = new Date(0).toISOString();
  return {
    id: n.id ?? '',
    identifier: n.identifier ?? '',
    title: n.title ?? '',
    description: n.description ?? null,
    state: n.state?.name ?? 'Unknown',
    url: n.url ?? '',
    createdAt: n.createdAt ?? n.updatedAt ?? now,
    updatedAt: n.updatedAt ?? n.createdAt ?? now,
    assignee: toUser(n.assignee),
    creator: toUser(n.creator),
    priorityLabel: n.priorityLabel ?? null,
    teamKey: n.team?.key ?? null,
  };
}

/**
 * Real Linear client — GraphQL over `https://api.linear.app/graphql` with the
 * Nango-minted OAuth token as the bearer. Untested against the live API until a
 * Linear integration is configured in Nango — exercised only by
 * `linear-client.smoke.test.ts` (`describe.skipIf(!LINEAR_SMOKE_TOKEN)`).
 * Everything above `LinearClient` runs on `FakeLinearClient`.
 */
export class HttpLinearClient implements LinearClient {
  private readonly accessToken: string;
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pageSize: number;

  constructor(options: HttpLinearClientOptions) {
    if (!options.accessToken) throw new Error('HttpLinearClient: accessToken is required');
    // OAuth access tokens (the Nango path) go as `Bearer <token>`; a raw
    // personal API key (`lin_api_…`, dev smoke test only) goes as-is.
    this.accessToken = options.accessToken.startsWith('lin_api_')
      ? options.accessToken
      : `Bearer ${options.accessToken}`;
    this.apiUrl = (options.apiUrl ?? DEFAULT_LINEAR_API_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.pageSize = options.pageSize ?? 50;
  }

  private async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const res = await this.fetchImpl(this.apiUrl, {
      method: 'POST',
      headers: {
        authorization: this.accessToken,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new LinearApiError(res.status, detail.slice(0, 500));
    }
    const body = (await res.json()) as GqlResponse<T>;
    if (body.errors?.length) {
      throw new LinearApiError(
        200,
        body.errors
          .map((e) => e.message ?? '')
          .join('; ')
          .slice(0, 500),
      );
    }
    if (!body.data) throw new LinearApiError(200, 'GraphQL response carried no data');
    return body.data;
  }

  async listWorkspace(): Promise<LinearWorkspace> {
    const memberIds: string[] = [];
    let after: string | undefined;
    let id = '';
    let name = '';
    do {
      const data = await this.gql<{
        organization: { id?: string | null; name?: string | null };
        users: { nodes: Array<{ id?: string | null }>; pageInfo: GqlPageInfo };
      }>(WORKSPACE_QUERY, { after: after ?? null });
      id = data.organization.id ?? id;
      name = data.organization.name ?? name;
      for (const u of data.users.nodes) if (u.id) memberIds.push(u.id);
      after = data.users.pageInfo.hasNextPage
        ? (data.users.pageInfo.endCursor ?? undefined)
        : undefined;
    } while (after);
    return { id, name, memberIds };
  }

  async listIssues(options: ListIssuesOptions = {}): Promise<LinearPage<LinearIssue>> {
    const filter = options.updatedSince ? { updatedAt: { gte: options.updatedSince } } : undefined;
    const data = await this.gql<{
      issues: { nodes: GqlIssue[]; pageInfo: GqlPageInfo };
    }>(ISSUES_QUERY, {
      after: options.cursor ?? null,
      first: options.limit ?? this.pageSize,
      filter: filter ?? null,
    });
    return {
      items: data.issues.nodes.map(toIssue),
      nextCursor: data.issues.pageInfo.hasNextPage
        ? (data.issues.pageInfo.endCursor ?? null)
        : null,
    };
  }
}
