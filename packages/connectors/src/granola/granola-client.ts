/**
 * The seam over Granola (https://granola.ai) — a "direct thin client" in the
 * connector strategy: Granola exposes a REST API keyed by a workspace bearer
 * token (`grn_…`). `HttpGranolaClient` speaks that API; `FakeGranolaClient` is a
 * deterministic in-memory stand-in that `GranolaConnector` and its tests run
 * against. Swapping the real client in is a config flip (`GRANOLA_API_KEY`
 * present) — see `loadGranolaClient`.
 *
 * Granola's wire shapes (snake_case payloads, versioned transcript formats,
 * pagination envelopes) stay inside `HttpGranolaClient`; everything above this
 * interface sees only the normalized types below.
 */

/** A Granola workspace — the tenancy + membership boundary in Granola. */
export interface GranolaWorkspace {
  id: string;
  name: string;
  /** external ids of the workspace's members — the basis for the source ACL */
  memberIds: string[];
}

/** A person attached to a Granola document (meeting attendee / note collaborator). */
export interface GranolaParticipant {
  /** Granola's stable person id */
  id: string;
  name: string | null;
  email: string | null;
}

/** One Granola document — a meeting's notes, with or without a transcript. */
export interface GranolaDocument {
  id: string;
  workspaceId: string;
  title: string;
  /** ISO-8601 — the meeting time / document creation */
  createdAt: string;
  /** ISO-8601 — last edit; the incremental-sync ordering + cursor key */
  updatedAt: string;
  /** true when the document has an associated meeting transcript */
  hasTranscript: boolean;
  participants: GranolaParticipant[];
  /** deep link back into Granola, when the API returns one */
  url: string | null;
}

/** The notes-panel body of a document (markdown flattened to text). */
export interface GranolaDocumentBody {
  documentId: string;
  notes: string | null;
}

export interface GranolaTranscriptSegment {
  /** diarized speaker label, when Granola resolved one */
  speaker: string | null;
  text: string;
  /** seconds from the start of the recording; null if not time-aligned */
  start: number | null;
}

export interface GranolaTranscript {
  documentId: string;
  segments: GranolaTranscriptSegment[];
}

/** One page of a listing plus the opaque cursor for the next page (null = last page). */
export interface GranolaPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface ListDocumentsOptions {
  /** only documents updated at/after this ISO-8601 instant (inclusive) */
  updatedSince?: string;
  /** page cursor from a previous `GranolaPage.nextCursor` */
  cursor?: string;
  /** page size hint */
  limit?: number;
}

export interface GranolaClient {
  /** Every workspace the bearer token can see. */
  listWorkspaces(): Promise<GranolaWorkspace[]>;
  /**
   * One page of documents, **ordered by `updatedAt` ascending** so a sync can
   * checkpoint on the last item's `updatedAt` and resume from there.
   */
  listDocuments(options?: ListDocumentsOptions): Promise<GranolaPage<GranolaDocument>>;
  /** The notes-panel body of a document. */
  getDocumentBody(documentId: string): Promise<GranolaDocumentBody>;
  /** The meeting transcript for a document. Call only when `hasTranscript`. */
  getTranscript(documentId: string): Promise<GranolaTranscript>;
}

/** Raised by `HttpGranolaClient` for a non-2xx Granola response. Message carries no document content. */
export class GranolaApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly detail: string,
  ) {
    super(`Granola API ${method} ${path} → ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'GranolaApiError';
  }
}

/** `sources.connector` value + `Connector.id` for Granola-ingested artifacts. */
export const GRANOLA_CONNECTOR = 'granola';

/** How long a Granola workspace-membership ACL snapshot may be trusted before a refresh. */
export const GRANOLA_ACL_TTL_SECONDS = 3600;
