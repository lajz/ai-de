import {
  artifactEmit,
  checkpointEmit,
  effectiveRetention,
  storesRawBody,
  type AclSnapshot,
  type CanonicalRecord,
  type Connector,
  type ConnectorContext,
  type ConnectorWebhookRequest,
  type ExternalRef,
  type RawArtifact,
  type RetentionPolicy,
  type SyncCursor,
  type SyncEmit,
} from '@fde/core';

import {
  GRANOLA_ACL_TTL_SECONDS,
  GRANOLA_CONNECTOR,
  type GranolaClient,
  type GranolaDocument,
  type GranolaParticipant,
  type GranolaTranscriptSegment,
  type GranolaWorkspace,
} from './granola-client.js';

export interface GranolaConnectorOptions {
  client: GranolaClient;
  /**
   * The engagement's retention policy. The connector's *effective* policy is
   * `effectiveRetention('granola', …)` of it — Granola is not force-pinned, so
   * this passes through, but routing it through `effectiveRetention` keeps the
   * one code path every connector uses.
   */
  engagementRetentionPolicy: RetentionPolicy;
}

/** Flatten transcript segments to one speaker-tagged line each. */
export function renderGranolaTranscript(segments: GranolaTranscriptSegment[]): string {
  return segments
    .map((s) => {
      const line = s.text.replace(/\s+/g, ' ').trim();
      return s.speaker ? `${s.speaker}: ${line}` : line;
    })
    .filter((line) => line.length > 0)
    .join('\n');
}

/**
 * Granola — a **direct thin client** connector (`grn_` workspace bearer over
 * REST). Read-only: pulls meeting documents + transcripts, snapshots the
 * workspace-membership ACL, and normalizes each document to a
 * meeting/document entity plus its participants.
 *
 * Transport lives in `GranolaClient` (`HttpGranolaClient` / `FakeGranolaClient`);
 * this class is the connector contract on top of it. `normalize` is pure;
 * `backfill` / `incremental` stream `SyncEmit`s and checkpoint on each page's
 * last `updatedAt`.
 */
export class GranolaConnector implements Connector {
  readonly id = GRANOLA_CONNECTOR;
  readonly authKind = 'bearer' as const;
  readonly retentionPolicy: RetentionPolicy;

  private readonly client: GranolaClient;
  /** memoized for the connector's lifetime (one sync run) — membership is stable enough within a run */
  private workspaces?: Promise<GranolaWorkspace[]>;

  constructor(options: GranolaConnectorOptions) {
    this.client = options.client;
    this.retentionPolicy = effectiveRetention(GRANOLA_CONNECTOR, options.engagementRetentionPolicy);
  }

  backfill(ctx: ConnectorContext): AsyncIterable<SyncEmit> {
    return this.stream(ctx, null);
  }

  incremental(ctx: ConnectorContext, cursor: SyncCursor | null): AsyncIterable<SyncEmit> {
    return this.stream(ctx, cursor);
  }

  /**
   * Granola has no public webhook API today, so incremental sync is
   * cursor-poll only. Seam: when Granola ships document-change webhooks, verify
   * the signature header here and map the payload to `RawArtifact[]` the same
   * way `stream` builds one from a `GranolaDocument`.
   */
  async handleWebhook(_req: ConnectorWebhookRequest): Promise<RawArtifact[]> {
    return [];
  }

  /**
   * Workspace-membership ACL: a Granola document is visible to the members of
   * its workspace. If the workspace (or its membership) can't be resolved —
   * Granola doesn't expose a per-document ACL — fall back to an
   * engagement-scoped **empty** rule set: access is then governed by engagement
   * membership alone, the same posture self-captured meetings take
   * (`apps/workers/src/activities/transcript-source.ts`). `ACLRefresh` can
   * enrich the snapshot later.
   */
  async resolveAcl(_ctx: ConnectorContext, artifact: RawArtifact): Promise<AclSnapshot> {
    const capturedAt = new Date().toISOString();
    const ws = (await this.listWorkspaces()).find((w) => w.id === artifact.workspaceRef);
    if (!ws || ws.memberIds.length === 0) {
      return { rules: [], capturedAt, ttlSeconds: GRANOLA_ACL_TTL_SECONDS };
    }
    return {
      rules: [
        {
          scope: 'granola_workspace',
          resourceId: ws.id,
          principals: [...ws.memberIds],
          public: false,
        },
      ],
      capturedAt,
      ttlSeconds: GRANOLA_ACL_TTL_SECONDS,
    };
  }

  normalize(artifact: RawArtifact): CanonicalRecord[] {
    const raw = (artifact.raw ?? {}) as { title?: unknown; participants?: unknown };
    const title =
      typeof raw.title === 'string' && raw.title.trim()
        ? raw.title.trim()
        : '(untitled Granola document)';
    const participants: GranolaParticipant[] = Array.isArray(raw.participants)
      ? (raw.participants as GranolaParticipant[])
      : [];

    const docRef: ExternalRef = {
      connector: GRANOLA_CONNECTOR,
      externalId: artifact.externalId,
      ...(artifact.urlPermalink ? { url: artifact.urlPermalink } : {}),
    };

    const records: CanonicalRecord[] = [
      {
        kind: 'entity',
        type: artifact.kind === 'transcript' ? 'meeting' : 'document',
        displayName: title,
        externalRefs: [docRef],
        attributes: {
          ...(artifact.workspaceRef ? { workspaceRef: artifact.workspaceRef } : {}),
          occurredAt: artifact.occurredAt,
        },
        // The body is data, never instructions (`docs/architecture.md`:
        // "Prompt-injection posture"). It is carried verbatim for downstream
        // encryption + extraction; nothing here interprets it.
        ...(artifact.body ? { body: artifact.body } : {}),
      },
    ];

    for (const p of participants) {
      if (!p?.id) continue;
      const refs: ExternalRef[] = [{ connector: GRANOLA_CONNECTOR, externalId: p.id }];
      // A deterministic identity key for `@fde/identity` — merge/dedup is that
      // package's job; `normalize` only emits the refs.
      if (p.email) refs.push({ connector: 'email', externalId: p.email.toLowerCase() });

      records.push({
        kind: 'entity',
        type: 'person',
        displayName: p.name?.trim() || p.email || p.id,
        externalRefs: refs,
        attributes: p.email ? { email: p.email } : {},
      });
      records.push({
        kind: 'relationship',
        from: { connector: GRANOLA_CONNECTOR, externalId: p.id },
        predicate: 'relates_to',
        to: { connector: GRANOLA_CONNECTOR, externalId: artifact.externalId },
      });
    }

    return records;
  }

  // --- internals ---------------------------------------------------------

  private listWorkspaces(): Promise<GranolaWorkspace[]> {
    return (this.workspaces ??= this.client.listWorkspaces());
  }

  private async *stream(ctx: ConnectorContext, cursor: SyncCursor | null): AsyncIterable<SyncEmit> {
    let pageCursor: string | undefined;
    let lastUpdatedAt: string | null = cursor;

    do {
      if (ctx.signal.aborted) return;
      const page = await this.client.listDocuments({
        updatedSince: cursor ?? undefined,
        cursor: pageCursor,
      });

      for (const doc of page.items) {
        if (ctx.signal.aborted) return;
        yield artifactEmit(await this.toArtifact(doc));
        lastUpdatedAt = doc.updatedAt;
      }

      // Checkpoint on the page's last `updatedAt`: a crashed run resumes from
      // there. Documents share `updatedAt` rarely; the `sources` dedupe key
      // absorbs a re-emitted boundary document.
      if (page.items.length > 0 && lastUpdatedAt) {
        yield checkpointEmit(lastUpdatedAt);
      }
      pageCursor = page.nextCursor ?? undefined;
    } while (pageCursor);
  }

  private async toArtifact(doc: GranolaDocument): Promise<RawArtifact> {
    const kind = doc.hasTranscript ? 'transcript' : 'doc';
    const retain = storesRawBody(this.retentionPolicy);

    const body = doc.hasTranscript
      ? renderGranolaTranscript((await this.client.getTranscript(doc.id)).segments)
      : ((await this.client.getDocumentBody(doc.id)).notes ?? '');

    const base = {
      connector: GRANOLA_CONNECTOR,
      externalId: doc.id,
      kind,
      ...(doc.url ? { urlPermalink: doc.url } : {}),
      workspaceRef: doc.workspaceId || undefined,
      occurredAt: doc.createdAt,
      // Body omitted entirely under `reference-only` — no durable copy.
      ...(retain && body ? { body } : {}),
      // `raw` carries only re-normalization metadata — never the content body
      // (that is `body`, and it is what gets field-encrypted or dropped). Keeps
      // `raw` safe to hold even under `reference-only`.
      raw: { title: doc.title, participants: doc.participants, hasTranscript: doc.hasTranscript },
    } satisfies Omit<RawArtifact, 'acl'>;

    // A schema-valid placeholder only. The authoritative snapshot is produced by
    // the runner calling `resolveAcl(ctx, artifact)` as its own provenance step
    // (`docs/architecture.md`: RawArtifact → resolveAcl → normalize) — this
    // connector does not resolve it twice.
    return {
      ...base,
      acl: { rules: [], capturedAt: new Date().toISOString(), ttlSeconds: GRANOLA_ACL_TTL_SECONDS },
    };
  }
}
