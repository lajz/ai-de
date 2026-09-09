import {
  GranolaApiError,
  type GranolaClient,
  type GranolaDocument,
  type GranolaDocumentBody,
  type GranolaPage,
  type GranolaTranscript,
  type GranolaTranscriptSegment,
  type GranolaWorkspace,
  type ListDocumentsOptions,
} from './granola-client.js';

/** Granola's API host. Override with `GRANOLA_API_BASE_URL`. */
export const DEFAULT_GRANOLA_BASE_URL = 'https://api.granola.ai';

export interface HttpGranolaClientOptions {
  /** workspace bearer token (`grn_…`) */
  apiKey: string;
  /** API host, no trailing slash (default `DEFAULT_GRANOLA_BASE_URL`) */
  baseUrl?: string;
  /** injectable for tests; defaults to global `fetch` */
  fetchImpl?: typeof fetch;
}

// --- Granola wire shapes (kept private to this module) --------------------

interface WsResponse {
  workspaces?: Array<{
    id?: string;
    display_name?: string | null;
    name?: string | null;
    members?: Array<{ user_id?: string | null; id?: string | null }> | null;
  }>;
}

interface DocEntry {
  id?: string;
  workspace_id?: string | null;
  title?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  /** either an explicit flag or the presence of a transcript id */
  has_transcript?: boolean | null;
  transcript_id?: string | null;
  people?: Array<{ id?: string | null; name?: string | null; email?: string | null }> | null;
  deeplink?: string | null;
  url?: string | null;
}

interface DocsResponse {
  documents?: DocEntry[];
  next_cursor?: string | null;
}

interface DocBodyResponse {
  id?: string;
  notes_plain?: string | null;
  notes_markdown?: string | null;
  notes?: string | null;
}

interface TranscriptResponse {
  segments?: Array<{
    speaker?: string | null;
    speaker_name?: string | null;
    text?: string | null;
    start_seconds?: number | null;
    start?: number | null;
  }>;
  transcript?: TranscriptResponse['segments'];
}

function toDocument(e: DocEntry): GranolaDocument {
  return {
    id: e.id ?? '',
    workspaceId: e.workspace_id ?? '',
    title: e.title ?? '',
    createdAt: e.created_at ?? e.updated_at ?? new Date(0).toISOString(),
    updatedAt: e.updated_at ?? e.created_at ?? new Date(0).toISOString(),
    hasTranscript: e.has_transcript ?? e.transcript_id != null,
    participants: (e.people ?? []).map((p) => ({
      id: p.id ?? p.email ?? '',
      name: p.name ?? null,
      email: p.email ?? null,
    })),
    url: e.deeplink ?? e.url ?? null,
  };
}

function toSegments(res: TranscriptResponse): GranolaTranscriptSegment[] {
  return (res.segments ?? res.transcript ?? []).map((s) => ({
    speaker: s.speaker ?? s.speaker_name ?? null,
    text: (s.text ?? '').trim(),
    start: typeof s.start_seconds === 'number' ? s.start_seconds : (s.start ?? null),
  }));
}

/**
 * Real Granola client. Untested against the live API until `GRANOLA_API_KEY`
 * lands — exercised only by `granola-client.smoke.test.ts`
 * (`describe.skipIf(!GRANOLA_API_KEY)`). Everything above `GranolaClient` runs
 * on `FakeGranolaClient`.
 */
export class HttpGranolaClient implements GranolaClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpGranolaClientOptions) {
    if (!options.apiKey) throw new Error('HttpGranolaClient: apiKey is required');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_GRANOLA_BASE_URL).replace(/\/$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.apiKey}`, accept: 'application/json' },
    });
    if (!res.ok) {
      // Granola error bodies are small JSON (`{"error":"…"}`) — safe to surface
      // (no document content). Cap length defensively.
      const detail = await res.text().catch(() => '');
      throw new GranolaApiError(res.status, method, path, detail.slice(0, 500));
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async listWorkspaces(): Promise<GranolaWorkspace[]> {
    const res = await this.request<WsResponse>('GET', '/v1/workspaces');
    return (res.workspaces ?? []).map((w) => ({
      id: w.id ?? '',
      name: w.display_name ?? w.name ?? '',
      memberIds: (w.members ?? [])
        .map((m) => m.user_id ?? m.id ?? '')
        .filter((id): id is string => id.length > 0),
    }));
  }

  async listDocuments(options: ListDocumentsOptions = {}): Promise<GranolaPage<GranolaDocument>> {
    const q = new URLSearchParams({ sort: 'updated_at', order: 'asc' });
    if (options.updatedSince) q.set('updated_since', options.updatedSince);
    if (options.cursor) q.set('cursor', options.cursor);
    if (options.limit) q.set('limit', String(options.limit));
    const res = await this.request<DocsResponse>('GET', `/v1/documents?${q.toString()}`);
    return {
      items: (res.documents ?? []).map(toDocument),
      nextCursor: res.next_cursor ?? null,
    };
  }

  async getDocumentBody(documentId: string): Promise<GranolaDocumentBody> {
    const res = await this.request<DocBodyResponse>(
      'GET',
      `/v1/documents/${encodeURIComponent(documentId)}`,
    );
    return {
      documentId,
      notes: res.notes_plain ?? res.notes_markdown ?? res.notes ?? null,
    };
  }

  async getTranscript(documentId: string): Promise<GranolaTranscript> {
    const res = await this.request<TranscriptResponse>(
      'GET',
      `/v1/documents/${encodeURIComponent(documentId)}/transcript`,
    );
    return { documentId, segments: toSegments(res) };
  }
}
