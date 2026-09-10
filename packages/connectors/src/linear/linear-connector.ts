import { createHmac, timingSafeEqual } from 'node:crypto';

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

import { type LinearClientFactory } from './load-linear-client.js';
import {
  LINEAR_ACL_TTL_SECONDS,
  LINEAR_CONNECTOR,
  LINEAR_WEBHOOK_SIGNATURE_HEADER,
  type LinearIssue,
  type LinearClient,
  type LinearUser,
  type LinearWorkspace,
} from './linear-client.js';

export interface LinearConnectorOptions {
  /** builds a `LinearClient` from the Nango-minted OAuth token for this run */
  clientFactory: LinearClientFactory;
  /**
   * The engagement's retention policy. The connector's *effective* policy is
   * `effectiveRetention('linear', …)` of it — Linear is not force-pinned
   * (the architecture calls Linear an "engagement policy" connector), so this
   * passes through, but routing it through `effectiveRetention` keeps the one
   * code path every connector uses.
   */
  engagementRetentionPolicy: RetentionPolicy;
  /**
   * Shared secret for verifying inbound Linear webhook signatures
   * (`LINEAR_WEBHOOK_SECRET`). Absent → `handleWebhook` rejects every payload:
   * an unverifiable webhook is not ingested. (Nango can alternatively proxy +
   * verify webhooks — see `src/nango/README.md`.)
   */
  webhookSecret?: string;
}

/**
 * Marker convention linking a Linear issue back to a decision fact: a literal
 * `fde:decision:<id>` token anywhere in the issue description. No NLP, no
 * heuristics — the link is explicit or it is absent. `<id>` is matched against
 * the decision fact's external ref during graph load; an unresolved marker is
 * dropped there, not here.
 *
 * Follow-up: also accept an `fde` fact permalink URL once the web app's fact
 * routes are stable.
 */
const DECISION_MARKER = /fde:decision:([A-Za-z0-9._-]+)/g;

/** Every distinct decision id marked in `text`, in first-seen order. */
export function extractDecisionRefs(text: string | null | undefined): string[] {
  if (!text) return [];
  const seen = new Set<string>();
  for (const m of text.matchAll(DECISION_MARKER)) {
    if (m[1]) seen.add(m[1]);
  }
  return [...seen];
}

interface LinearArtifactMeta {
  identifier: string;
  title: string;
  state: string;
  url: string;
  priorityLabel: string | null;
  teamKey: string | null;
  updatedAt: string;
  assignee: LinearUser | null;
  creator: LinearUser | null;
  /** decision ids marked in the description — see `DECISION_MARKER`. Never the body itself. */
  decisionRefs: string[];
}

/**
 * Linear — a **Nango-backed** connector (`authKind: 'nango-oauth'`). Pulls work
 * items (issues), snapshots the workspace-membership ACL, and normalizes each
 * issue to a `work_item` entity plus its assignee/creator people and their
 * relationships, with an optional marker-driven `(decision)-[implemented_by]->`
 * edge.
 *
 * Ingestion only for M3 — the `Connector` contract is read-only. Writing a
 * back-link comment to Linear is a documented follow-up.
 *
 * Transport lives in `LinearClient` (`HttpLinearClient` / `FakeLinearClient`);
 * this class is the connector contract on top of it. The bearer token comes
 * from `ctx.getCredential()` (self-hosted Nango) — fetched once per run.
 * `normalize` is pure; `backfill` / `incremental` stream `SyncEmit`s and
 * checkpoint on each page's last `updatedAt`.
 */
export class LinearConnector implements Connector {
  readonly id = LINEAR_CONNECTOR;
  readonly authKind = 'nango-oauth' as const;
  readonly retentionPolicy: RetentionPolicy;

  private readonly clientFactory: LinearClientFactory;
  private readonly webhookSecret?: string;
  /** memoized for the connector's lifetime (one sync run) — one Nango token fetch, one client */
  private clientPromise?: Promise<LinearClient>;
  /** memoized workspace membership — stable enough within a run */
  private workspacePromise?: Promise<LinearWorkspace>;

  constructor(options: LinearConnectorOptions) {
    this.clientFactory = options.clientFactory;
    this.webhookSecret = options.webhookSecret;
    this.retentionPolicy = effectiveRetention(LINEAR_CONNECTOR, options.engagementRetentionPolicy);
  }

  backfill(ctx: ConnectorContext): AsyncIterable<SyncEmit> {
    return this.stream(ctx, null);
  }

  incremental(ctx: ConnectorContext, cursor: SyncCursor | null): AsyncIterable<SyncEmit> {
    return this.stream(ctx, cursor);
  }

  /**
   * Parse a Linear `Issue` webhook into a single `RawArtifact`. The signature
   * (`linear-signature`, HMAC-SHA256 hex over the raw body) is verified against
   * `webhookSecret` first — a missing secret or a bad signature throws, and
   * nothing is ingested. `remove` actions and non-`Issue` types yield `[]`
   * (deletes are a follow-up; the graph is additive for M3).
   */
  async handleWebhook(req: ConnectorWebhookRequest): Promise<RawArtifact[]> {
    this.verifySignature(req);

    const payload = JSON.parse(Buffer.from(req.rawBody).toString('utf8')) as {
      action?: string;
      type?: string;
      data?: Record<string, unknown>;
    };
    if (payload.type !== 'Issue' || payload.action === 'remove' || !payload.data) return [];

    return [this.toArtifact(issueFromWebhook(payload.data))];
  }

  /**
   * Workspace-membership ACL: a Linear issue is visible to the members of the
   * workspace (Linear issues are workspace-wide, not per-team-private by
   * default). If the workspace membership can't be resolved, fall back to an
   * engagement-scoped **empty** rule set — access is then governed by
   * engagement membership alone, mirroring `GranolaConnector.resolveAcl`.
   * `ACLRefresh` can enrich the snapshot later.
   */
  async resolveAcl(ctx: ConnectorContext, _artifact: RawArtifact): Promise<AclSnapshot> {
    const capturedAt = new Date().toISOString();
    const ws = await this.workspace(ctx);
    if (!ws || ws.memberIds.length === 0) {
      return { rules: [], capturedAt, ttlSeconds: LINEAR_ACL_TTL_SECONDS };
    }
    return {
      rules: [
        {
          scope: 'linear_workspace',
          resourceId: ws.id,
          principals: [...ws.memberIds],
          public: false,
        },
      ],
      capturedAt,
      ttlSeconds: LINEAR_ACL_TTL_SECONDS,
    };
  }

  normalize(artifact: RawArtifact): CanonicalRecord[] {
    const meta = (artifact.raw ?? {}) as Partial<LinearArtifactMeta>;
    const identifier = meta.identifier?.trim() || artifact.externalId;
    const title = meta.title?.trim() ?? '';
    const displayName = [identifier, title].filter(Boolean).join(' ') || identifier;

    const workItemRef: ExternalRef = {
      connector: LINEAR_CONNECTOR,
      externalId: artifact.externalId,
      ...(artifact.urlPermalink ? { url: artifact.urlPermalink } : {}),
    };

    const records: CanonicalRecord[] = [
      {
        kind: 'entity',
        type: 'work_item',
        displayName,
        externalRefs: [workItemRef],
        attributes: {
          identifier,
          ...(meta.state ? { state: meta.state } : {}),
          ...(artifact.urlPermalink ? { url: artifact.urlPermalink } : {}),
          ...(meta.priorityLabel ? { priority: meta.priorityLabel } : {}),
          ...(meta.teamKey ? { teamKey: meta.teamKey } : {}),
          occurredAt: artifact.occurredAt,
        },
        // The description is data, never instructions (`docs/architecture.md`:
        // "Prompt-injection posture"). Carried verbatim for downstream
        // encryption + extraction; nothing here interprets it.
        ...(artifact.body ? { body: artifact.body } : {}),
      },
    ];

    // Assignee → owns; creator → informed_of. Emit each person entity once.
    const people = new Map<string, LinearUser>();
    const addPerson = (u: LinearUser | null | undefined) => {
      if (u?.id && !people.has(u.id)) people.set(u.id, u);
    };
    addPerson(meta.assignee);
    addPerson(meta.creator);
    for (const u of people.values()) {
      const refs: ExternalRef[] = [{ connector: LINEAR_CONNECTOR, externalId: u.id }];
      if (u.email) refs.push({ connector: 'email', externalId: u.email.toLowerCase() });
      records.push({
        kind: 'entity',
        type: 'person',
        displayName: u.name?.trim() || u.email || u.id,
        externalRefs: refs,
        attributes: u.email ? { email: u.email } : {},
      });
    }
    if (meta.assignee?.id) {
      records.push({
        kind: 'relationship',
        from: { connector: LINEAR_CONNECTOR, externalId: meta.assignee.id },
        predicate: 'owns',
        to: { connector: LINEAR_CONNECTOR, externalId: artifact.externalId },
      });
    }
    if (meta.creator?.id) {
      records.push({
        kind: 'relationship',
        from: { connector: LINEAR_CONNECTOR, externalId: meta.creator.id },
        predicate: 'informed_of',
        to: { connector: LINEAR_CONNECTOR, externalId: artifact.externalId },
      });
    }

    // Marker-driven decision link: (decision)-[implemented_by]->(work_item).
    for (const ref of meta.decisionRefs ?? []) {
      records.push({
        kind: 'relationship',
        from: { connector: 'fde', externalId: ref },
        predicate: 'implemented_by',
        to: { connector: LINEAR_CONNECTOR, externalId: artifact.externalId },
      });
    }

    return records;
  }

  // --- internals ---------------------------------------------------------

  private client(ctx: ConnectorContext): Promise<LinearClient> {
    return (this.clientPromise ??= ctx
      .getCredential()
      .then((cred) => this.clientFactory(cred.value)));
  }

  private async workspace(ctx: ConnectorContext): Promise<LinearWorkspace> {
    return (this.workspacePromise ??= this.client(ctx).then((c) => c.listWorkspace()));
  }

  private async *stream(ctx: ConnectorContext, cursor: SyncCursor | null): AsyncIterable<SyncEmit> {
    const client = await this.client(ctx);
    let pageCursor: string | undefined;
    let maxUpdatedAt: string | null = cursor;

    do {
      if (ctx.signal.aborted) return;
      const page = await client.listIssues({
        updatedSince: cursor ?? undefined,
        cursor: pageCursor,
      });

      for (const issue of page.items) {
        if (ctx.signal.aborted) return;
        yield artifactEmit(this.toArtifact(issue));
        if (!maxUpdatedAt || issue.updatedAt > maxUpdatedAt) maxUpdatedAt = issue.updatedAt;
      }
      pageCursor = page.nextCursor ?? undefined;
    } while (pageCursor);

    // One checkpoint, only once the stream has fully drained. Linear returns
    // issues **newest-first** (`orderBy: updatedAt`), so a per-page checkpoint
    // would be a high-water mark that skips the older, not-yet-processed issues
    // on an incremental resume. Emitting the run's max `updatedAt` only at the
    // end keeps the checkpoint a safe low-water mark: a mid-run crash advances
    // nothing, and Temporal's retry re-scans from the previous cursor with the
    // `sources` dedupe key absorbing the overlap.
    if (maxUpdatedAt && maxUpdatedAt !== cursor) yield checkpointEmit(maxUpdatedAt);
  }

  private toArtifact(issue: LinearIssue): RawArtifact {
    const retain = storesRawBody(this.retentionPolicy);
    const meta: LinearArtifactMeta = {
      identifier: issue.identifier,
      title: issue.title,
      state: issue.state,
      url: issue.url,
      priorityLabel: issue.priorityLabel,
      teamKey: issue.teamKey,
      updatedAt: issue.updatedAt,
      assignee: issue.assignee,
      creator: issue.creator,
      decisionRefs: extractDecisionRefs(issue.description),
    };

    return {
      connector: LINEAR_CONNECTOR,
      externalId: issue.id,
      kind: 'issue',
      ...(issue.url ? { urlPermalink: issue.url } : {}),
      occurredAt: issue.createdAt,
      // Body omitted entirely under `reference-only` — no durable copy.
      ...(retain && issue.description ? { body: issue.description } : {}),
      // `raw` carries only re-normalization metadata + the decision markers —
      // never the description text itself (that is `body`, which is what gets
      // field-encrypted or dropped). Keeps `raw` safe to hold under any policy.
      raw: meta as unknown as Record<string, unknown>,
      // Schema-valid placeholder only — the authoritative snapshot comes from
      // the runner calling `resolveAcl(ctx, artifact)` as its own step.
      acl: { rules: [], capturedAt: new Date().toISOString(), ttlSeconds: LINEAR_ACL_TTL_SECONDS },
    };
  }

  private verifySignature(req: ConnectorWebhookRequest): void {
    if (!this.webhookSecret) {
      throw new Error('LinearConnector.handleWebhook: LINEAR_WEBHOOK_SECRET is not configured');
    }
    const provided = req.headers[LINEAR_WEBHOOK_SIGNATURE_HEADER];
    if (!provided)
      throw new Error('LinearConnector.handleWebhook: missing linear-signature header');
    const expected = createHmac('sha256', this.webhookSecret)
      .update(Buffer.from(req.rawBody))
      .digest('hex');
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error('LinearConnector.handleWebhook: bad linear-signature');
    }
  }
}

/** Map a Linear webhook `data` object to the normalized `LinearIssue` shape. */
function issueFromWebhook(data: Record<string, unknown>): LinearIssue {
  const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const user = (v: unknown): LinearUser | null => {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    return o.id ? { id: String(o.id), name: s(o.name), email: s(o.email) } : null;
  };
  const now = new Date().toISOString();
  const state = data.state as Record<string, unknown> | undefined;
  const team = data.team as Record<string, unknown> | undefined;
  return {
    id: String(data.id ?? ''),
    identifier: s(data.identifier) ?? '',
    title: s(data.title) ?? '',
    description: s(data.description),
    state: s(state?.name) ?? 'Unknown',
    url: s(data.url) ?? '',
    createdAt: s(data.createdAt) ?? now,
    updatedAt: s(data.updatedAt) ?? now,
    assignee: user(data.assignee),
    creator: user(data.creator),
    priorityLabel: s(data.priorityLabel),
    teamKey: s(team?.key),
  };
}
