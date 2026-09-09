import {
  type GranolaClient,
  type GranolaDocument,
  type GranolaDocumentBody,
  type GranolaPage,
  type GranolaTranscript,
  type GranolaWorkspace,
  type ListDocumentsOptions,
} from './granola-client.js';

/**
 * A fixed two-workspace, three-document corpus — deterministic content for the
 * connector logic + its tests. One doc has a transcript, one is notes-only, one
 * lives in a second workspace whose membership the connector can't resolve.
 */
export const FAKE_WORKSPACES: GranolaWorkspace[] = [
  { id: 'ws-acme', name: 'Acme', memberIds: ['u-alice', 'u-bob'] },
  { id: 'ws-ghost', name: 'Ghost', memberIds: [] },
];

export const FAKE_DOCUMENTS: GranolaDocument[] = [
  {
    id: 'doc-standup',
    workspaceId: 'ws-acme',
    title: 'Acme weekly standup',
    createdAt: '2026-09-01T15:00:00.000Z',
    updatedAt: '2026-09-01T16:00:00.000Z',
    hasTranscript: true,
    participants: [
      { id: 'p-alice', name: 'Alice Rivera', email: 'alice@acme.example' },
      { id: 'p-bob', name: 'Bob Chen', email: 'bob@acme.example' },
    ],
    url: 'https://granola.ai/d/doc-standup',
  },
  {
    id: 'doc-brief',
    workspaceId: 'ws-acme',
    title: 'Project Orion brief',
    createdAt: '2026-09-02T09:00:00.000Z',
    updatedAt: '2026-09-02T09:30:00.000Z',
    hasTranscript: false,
    participants: [{ id: 'p-alice', name: 'Alice Rivera', email: 'alice@acme.example' }],
    url: 'https://granola.ai/d/doc-brief',
  },
  {
    id: 'doc-ext',
    workspaceId: 'ws-ghost',
    title: 'External sync',
    createdAt: '2026-09-03T12:00:00.000Z',
    updatedAt: '2026-09-03T12:15:00.000Z',
    hasTranscript: true,
    participants: [{ id: 'p-carol', name: null, email: 'carol@partner.example' }],
    url: null,
  },
];

const FAKE_TRANSCRIPTS: Record<string, GranolaTranscript> = {
  'doc-standup': {
    documentId: 'doc-standup',
    segments: [
      { speaker: 'Alice Rivera', text: 'Welcome everyone, quick round.', start: 0 },
      { speaker: 'Bob Chen', text: 'We decided to ship Orion on Friday.', start: 4 },
    ],
  },
  'doc-ext': {
    documentId: 'doc-ext',
    segments: [{ speaker: null, text: 'Partner confirmed the pilot scope.', start: 0 }],
  },
};

const FAKE_BODIES: Record<string, string> = {
  'doc-standup': 'Standup notes: Orion ship date confirmed for Friday.',
  'doc-brief': 'Orion brief: goals, scope, and the rollout plan.',
  'doc-ext': 'External sync notes.',
};

export interface FakeGranolaOptions {
  workspaces?: GranolaWorkspace[];
  documents?: GranolaDocument[];
  transcripts?: Record<string, GranolaTranscript>;
  bodies?: Record<string, string>;
  /** page size the fake paginates at (default 2 — exercises multi-page + checkpointing) */
  pageSize?: number;
}

/**
 * Dependency-free `GranolaClient`. No network: documents are served from a
 * sorted in-memory list, paginated so a sync run crosses page boundaries and
 * emits more than one checkpoint.
 */
export class FakeGranolaClient implements GranolaClient {
  private readonly workspaces: GranolaWorkspace[];
  private readonly documents: GranolaDocument[];
  private readonly transcripts: Record<string, GranolaTranscript>;
  private readonly bodies: Record<string, string>;
  private readonly pageSize: number;
  /** every document id `getTranscript` was called for — lets a test assert fetch counts */
  readonly transcriptFetches: string[] = [];

  constructor(options: FakeGranolaOptions = {}) {
    this.workspaces = options.workspaces ?? FAKE_WORKSPACES;
    this.documents = [...(options.documents ?? FAKE_DOCUMENTS)].sort(
      (a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id),
    );
    this.transcripts = options.transcripts ?? FAKE_TRANSCRIPTS;
    this.bodies = options.bodies ?? FAKE_BODIES;
    this.pageSize = options.pageSize ?? 2;
  }

  async listWorkspaces(): Promise<GranolaWorkspace[]> {
    return this.workspaces.map((w) => ({ ...w, memberIds: [...w.memberIds] }));
  }

  async listDocuments(options: ListDocumentsOptions = {}): Promise<GranolaPage<GranolaDocument>> {
    const filtered = options.updatedSince
      ? this.documents.filter((d) => d.updatedAt >= options.updatedSince!)
      : this.documents;
    const start = options.cursor ? Number(options.cursor) : 0;
    const size = options.limit ?? this.pageSize;
    const slice = filtered.slice(start, start + size);
    const next = start + size < filtered.length ? String(start + size) : null;
    return { items: slice.map((d) => structuredClone(d)), nextCursor: next };
  }

  async getDocumentBody(documentId: string): Promise<GranolaDocumentBody> {
    return { documentId, notes: this.bodies[documentId] ?? null };
  }

  async getTranscript(documentId: string): Promise<GranolaTranscript> {
    this.transcriptFetches.push(documentId);
    const t = this.transcripts[documentId];
    return t ? structuredClone(t) : { documentId, segments: [] };
  }
}
