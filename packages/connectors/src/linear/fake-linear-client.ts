import {
  type LinearClient,
  type LinearIssue,
  type LinearPage,
  type LinearWorkspace,
  type ListIssuesOptions,
} from './linear-client.js';

/** A fixed workspace + three-issue corpus — deterministic content for the connector logic + tests. */
export const FAKE_LINEAR_WORKSPACE: LinearWorkspace = {
  id: 'org-acme',
  name: 'Acme',
  memberIds: ['lu-alice', 'lu-bob'],
};

export const FAKE_LINEAR_ISSUES: LinearIssue[] = [
  {
    id: 'iss-1',
    identifier: 'ENG-1',
    title: 'Ship the Orion API',
    // carries a decision-link marker — see `extractDecisionRefs`
    description: 'Implements the Friday ship decision.\n\nfde:decision:dec-orion-ship',
    state: 'In Progress',
    url: 'https://linear.app/acme/issue/ENG-1',
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T12:00:00.000Z',
    assignee: { id: 'lu-alice', name: 'Alice Rivera', email: 'alice@acme.example' },
    creator: { id: 'lu-bob', name: 'Bob Chen', email: 'bob@acme.example' },
    priorityLabel: 'High',
    teamKey: 'ENG',
  },
  {
    id: 'iss-2',
    identifier: 'ENG-2',
    title: 'Write the migration guide',
    description: null,
    state: 'Todo',
    url: 'https://linear.app/acme/issue/ENG-2',
    createdAt: '2026-09-02T09:00:00.000Z',
    updatedAt: '2026-09-02T09:30:00.000Z',
    assignee: { id: 'lu-bob', name: 'Bob Chen', email: 'bob@acme.example' },
    creator: { id: 'lu-alice', name: 'Alice Rivera', email: 'alice@acme.example' },
    priorityLabel: null,
    teamKey: 'ENG',
  },
  {
    id: 'iss-3',
    identifier: 'ENG-3',
    title: 'Unassigned cleanup task',
    description: 'No owner yet.',
    state: 'Backlog',
    url: 'https://linear.app/acme/issue/ENG-3',
    createdAt: '2026-09-03T08:00:00.000Z',
    updatedAt: '2026-09-03T08:15:00.000Z',
    assignee: null,
    creator: { id: 'lu-alice', name: 'Alice Rivera', email: 'alice@acme.example' },
    priorityLabel: 'Low',
    teamKey: 'ENG',
  },
];

export interface FakeLinearOptions {
  workspace?: LinearWorkspace;
  issues?: LinearIssue[];
  /** page size the fake paginates at (default 2 — exercises multi-page + checkpointing) */
  pageSize?: number;
}

/**
 * Dependency-free `LinearClient`. No network: issues are served **newest-first**
 * (Linear's `orderBy: updatedAt` order), paginated so a sync run crosses page
 * boundaries.
 */
export class FakeLinearClient implements LinearClient {
  private readonly workspace: LinearWorkspace;
  private readonly issues: LinearIssue[];
  private readonly pageSize: number;

  constructor(options: FakeLinearOptions = {}) {
    this.workspace = options.workspace ?? FAKE_LINEAR_WORKSPACE;
    // descending by updatedAt — matches Linear (most recently updated first)
    this.issues = [...(options.issues ?? FAKE_LINEAR_ISSUES)].sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
    );
    this.pageSize = options.pageSize ?? 2;
  }

  async listWorkspace(): Promise<LinearWorkspace> {
    return { ...this.workspace, memberIds: [...this.workspace.memberIds] };
  }

  async listIssues(options: ListIssuesOptions = {}): Promise<LinearPage<LinearIssue>> {
    const filtered = options.updatedSince
      ? this.issues.filter((i) => i.updatedAt >= options.updatedSince!)
      : this.issues;
    const start = options.cursor ? Number(options.cursor) : 0;
    const size = options.limit ?? this.pageSize;
    const slice = filtered.slice(start, start + size);
    const next = start + size < filtered.length ? String(start + size) : null;
    return { items: slice.map((i) => structuredClone(i)), nextCursor: next };
  }
}
