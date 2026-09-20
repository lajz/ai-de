import { createHmac, timingSafeEqual } from 'node:crypto';

import {
  artifactEmit,
  checkpointEmit,
  effectiveRetention,
  storesRawBody,
  type AclSnapshot,
  type CanonicalEntity,
  type CanonicalRecord,
  type Connector,
  type ConnectorContext,
  type ConnectorCredential,
  type ConnectorWebhookRequest,
  type ExternalRef,
  type RawArtifact,
  type RetentionPolicy,
  type StatusChangeFact,
  type SyncCursor,
  type SyncEmit,
} from '@fde/core';

import { extractDecisionRefs } from '../decision-marker.js';
import {
  GITHUB_ACL_TTL_SECONDS,
  GITHUB_CONNECTOR,
  GITHUB_EVENT_HEADER,
  GITHUB_WEBHOOK_SIGNATURE_HEADER,
  type GitHubClient,
  type GitHubPullRequest,
  type GitHubRepository,
  type GitHubUser,
} from './github-client.js';
import { type GitHubClientFactory } from './load-github-client.js';

export interface GitHubConnectorOptions {
  /** builds a `GitHubClient` from the Nango-minted OAuth token + bound repo for this run */
  clientFactory: GitHubClientFactory;
  /**
   * The engagement's retention policy. The connector's *effective* policy is
   * `effectiveRetention('github', …)` of it — GitHub is not force-pinned, so
   * this passes through, mirroring `LinearConnectorOptions`.
   */
  engagementRetentionPolicy: RetentionPolicy;
  /**
   * Shared secret for verifying inbound GitHub webhook signatures
   * (`GITHUB_WEBHOOK_SECRET`). Absent → `handleWebhook` rejects every
   * payload: an unverifiable webhook is not ingested.
   */
  webhookSecret?: string;
}

interface GitHubArtifactMeta {
  repo: string;
  number: number;
  title: string;
  state: 'open' | 'closed';
  merged: boolean;
  url: string;
  baseRef: string;
  headRef: string;
  updatedAt: string;
  author: GitHubUser | null;
  requestedReviewers: GitHubUser[];
  completedReviewers: GitHubUser[];
  /** decision ids marked in the PR body — see `extractDecisionRefs`. Never the body itself. */
  decisionRefs: string[];
}

const RECOGNIZED_PR_ACTIONS = new Set(['opened', 'edited', 'closed', 'reopened', 'synchronize']);

/**
 * GitHub — a **Nango-backed** connector (`authKind: 'nango-oauth'`), the same
 * template `LinearConnector` established: pulls pull requests, snapshots a
 * repo-level ACL, and normalizes each PR to a `work_item` entity plus its
 * author/reviewer people and their relationships, with an optional
 * marker-driven `(decision)-[implemented_by]->` edge (a PR body carrying
 * `fde:decision:<id>`, the same convention Linear issue descriptions use —
 * `../decision-marker.js`).
 *
 * **v1 scope** — PR-level state only: number, title, description, state
 * (open/closed/merged), base/head branch, author, requested + completed
 * reviewers, url, timestamps. No inline review comments, no commits, no
 * per-review detail (approve/request-changes/comment) — just *who* reviewed.
 * Write-back (a decision-link comment on the PR) is a documented follow-up,
 * same as Linear's.
 *
 * **Repo scope**: one connection is bound to exactly one `owner/repo` (the
 * shape `externalScopeRef` already supports — see
 * `packages/db/src/schema/connector-config.ts`). The connector itself never
 * reads `connector_config` directly (neither does `LinearConnector`); instead
 * it learns the repo from `ConnectorCredential.metadata.repo`, the same
 * Nango-connection-metadata channel `NangoConnection.metadata` already exists
 * for ("workspace id, region, …" — `nango/nango-client.ts`). Set it once, at
 * Nango-connect time, for the connection backing this engagement's GitHub
 * config (see `nango/README.md`'s GitHub section). This keeps `ConnectorContext`,
 * `apps/workers/.../connector-sync.ts`, and `WebhookLandingService` completely
 * unchanged — exactly the "no shared-plumbing changes" constraint this PR is
 * scoped to.
 *
 * Ingestion only for v1 — the `Connector` contract is read-only.
 *
 * Transport lives in `GitHubClient` (`HttpGitHubClient` / `FakeGitHubClient`);
 * this class is the connector contract on top of it. `normalize` is pure;
 * `backfill` / `incremental` stream `SyncEmit`s and checkpoint — see `stream`
 * for why GitHub can checkpoint more often than Linear.
 */
export class GitHubConnector implements Connector {
  readonly id = GITHUB_CONNECTOR;
  readonly authKind = 'nango-oauth' as const;
  readonly retentionPolicy: RetentionPolicy;

  private readonly clientFactory: GitHubClientFactory;
  private readonly webhookSecret?: string;
  /** memoized for the connector's lifetime (one sync run) — one credential fetch */
  private credentialPromise?: Promise<ConnectorCredential>;
  /** memoized client — depends on the credential's bound repo */
  private clientPromise?: Promise<GitHubClient>;
  /** memoized repo snapshot — stable enough within a run */
  private repositoryPromise?: Promise<GitHubRepository>;

  constructor(options: GitHubConnectorOptions) {
    this.clientFactory = options.clientFactory;
    this.webhookSecret = options.webhookSecret;
    this.retentionPolicy = effectiveRetention(GITHUB_CONNECTOR, options.engagementRetentionPolicy);
  }

  backfill(ctx: ConnectorContext): AsyncIterable<SyncEmit> {
    return this.stream(ctx, null);
  }

  incremental(ctx: ConnectorContext, cursor: SyncCursor | null): AsyncIterable<SyncEmit> {
    return this.stream(ctx, cursor);
  }

  /**
   * Parse a GitHub `pull_request` webhook into a single `RawArtifact`. The
   * signature (`x-hub-signature-256`, `sha256=<hex>` over the raw body) is
   * verified against `webhookSecret` first — a missing secret or a bad
   * signature throws, and nothing is ingested. Any event other than
   * `pull_request` (routed via the `x-github-event` header), and any
   * `pull_request` action outside `opened`/`edited`/`closed`/`reopened`/
   * `synchronize` (e.g. `labeled`, `review_requested`), yields `[]`.
   *
   * GitHub's `pull_request` webhook payload carries `requested_reviewers` but
   * never completed-review state (that is the separate `pull_request_review`
   * event, out of scope for v1) — a webhook-sourced artifact's
   * `completedReviewers` is always empty. `backfill`/`incremental` fill it in
   * via the REST reviews endpoint (`HttpGitHubClient.completedReviewers`),
   * so a repo's reviewer history is still complete after the next sync run;
   * this is a documented gap in the webhook path only, not a permanent one.
   */
  async handleWebhook(req: ConnectorWebhookRequest): Promise<RawArtifact[]> {
    this.verifySignature(req);

    const event = req.headers[GITHUB_EVENT_HEADER];
    if (event !== 'pull_request') return [];

    const payload = JSON.parse(Buffer.from(req.rawBody).toString('utf8')) as {
      action?: string;
      pull_request?: Record<string, unknown>;
      repository?: { full_name?: string };
    };
    if (!payload.action || !RECOGNIZED_PR_ACTIONS.has(payload.action) || !payload.pull_request) {
      return [];
    }
    const repoFullName = payload.repository?.full_name;
    if (!repoFullName) return [];

    return [this.toArtifact(pullRequestFromWebhook(payload.pull_request), repoFullName)];
  }

  /**
   * Repo-level ACL snapshot: a private repo is visible to its collaborators;
   * a public repo is visible to everyone (`public: true`, no principal list
   * needed). If collaborators can't be resolved (token lacks scope), fall
   * back to an engagement-scoped **empty** rule set — access is then governed
   * by engagement membership alone, mirroring `LinearConnector.resolveAcl`.
   */
  async resolveAcl(ctx: ConnectorContext, _artifact: RawArtifact): Promise<AclSnapshot> {
    const capturedAt = new Date().toISOString();
    const repo = await this.repository(ctx);
    if (!repo.private) {
      return {
        rules: [{ scope: 'github_repo', resourceId: repo.fullName, principals: [], public: true }],
        capturedAt,
        ttlSeconds: GITHUB_ACL_TTL_SECONDS,
      };
    }
    if (repo.collaboratorIds.length === 0) {
      return { rules: [], capturedAt, ttlSeconds: GITHUB_ACL_TTL_SECONDS };
    }
    return {
      rules: [
        {
          scope: 'github_repo',
          resourceId: repo.fullName,
          principals: [...repo.collaboratorIds],
          public: false,
        },
      ],
      capturedAt,
      ttlSeconds: GITHUB_ACL_TTL_SECONDS,
    };
  }

  normalize(artifact: RawArtifact): CanonicalRecord[] {
    const meta = (artifact.raw ?? {}) as Partial<GitHubArtifactMeta>;
    const identifier =
      meta.repo && meta.number ? `${meta.repo}#${meta.number}` : artifact.externalId;
    const title = meta.title?.trim() ?? '';
    const displayName = [identifier, title].filter(Boolean).join(' ') || identifier;

    const workItemRef: ExternalRef = {
      connector: GITHUB_CONNECTOR,
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
          ...(meta.repo ? { repo: meta.repo } : {}),
          ...(meta.number !== undefined ? { number: meta.number } : {}),
          ...(meta.state ? { state: meta.state } : {}),
          ...(meta.merged !== undefined ? { merged: meta.merged } : {}),
          ...(artifact.urlPermalink ? { url: artifact.urlPermalink } : {}),
          ...(meta.baseRef ? { baseRef: meta.baseRef } : {}),
          ...(meta.headRef ? { headRef: meta.headRef } : {}),
          occurredAt: artifact.occurredAt,
        },
        // The description is data, never instructions — same prompt-injection
        // posture as `LinearConnector.normalize`. Carried verbatim for
        // downstream encryption + extraction; nothing here interprets it.
        ...(artifact.body ? { body: artifact.body } : {}),
      },
    ];

    // Author → owns; each reviewer (requested + completed) → informed_of.
    // Emit each person entity once, mirroring Linear's `people` map.
    const people = new Map<string, GitHubUser>();
    const addPerson = (u: GitHubUser | null | undefined) => {
      if (u?.id && !people.has(u.id)) people.set(u.id, u);
    };
    addPerson(meta.author);
    for (const r of meta.requestedReviewers ?? []) addPerson(r);
    for (const r of meta.completedReviewers ?? []) addPerson(r);
    for (const u of people.values()) {
      records.push({
        kind: 'entity',
        type: 'person',
        displayName: u.name?.trim() || u.login || u.id,
        externalRefs: [{ connector: GITHUB_CONNECTOR, externalId: u.id }],
        attributes: u.login ? { login: u.login } : {},
      });
    }
    if (meta.author?.id) {
      records.push({
        kind: 'relationship',
        from: { connector: GITHUB_CONNECTOR, externalId: meta.author.id },
        predicate: 'owns',
        to: { connector: GITHUB_CONNECTOR, externalId: artifact.externalId },
      });
    }
    const reviewerIds = new Set<string>();
    for (const r of [...(meta.requestedReviewers ?? []), ...(meta.completedReviewers ?? [])]) {
      if (!r.id || reviewerIds.has(r.id)) continue;
      reviewerIds.add(r.id);
      records.push({
        kind: 'relationship',
        from: { connector: GITHUB_CONNECTOR, externalId: r.id },
        predicate: 'informed_of',
        to: { connector: GITHUB_CONNECTOR, externalId: artifact.externalId },
      });
    }

    // Marker-driven decision link: (decision)-[implemented_by]->(work_item).
    for (const ref of meta.decisionRefs ?? []) {
      records.push({
        kind: 'relationship',
        from: { connector: 'fde', externalId: ref },
        predicate: 'implemented_by',
        to: { connector: GITHUB_CONNECTOR, externalId: artifact.externalId },
      });
    }

    return records;
  }

  /**
   * Fires on the two PR transitions that are unambiguous and valuable from the
   * `merged` boolean + `state` string alone:
   *
   * - merged: `false → true` — "PR #<n> merged into <baseRef>".
   * - closed without merging: `state !== 'closed' → 'closed'` while `merged`
   *   stays `false` — a real but lower-signal case, included since it's cheap
   *   and mutually exclusive with the merge case.
   *
   * Anything else (a title/description edit, a review, re-opening) returns
   * `null`. `occurredAt` is "now" (when this system observed the transition)
   * rather than a GitHub timestamp — `next.attributes` carries the PR's
   * `createdAt` under the (confusingly-named) `occurredAt` key, not an
   * update/merge timestamp, so there is no more precise moment available here.
   */
  detectStatusChange(
    previous: Record<string, unknown>,
    next: CanonicalEntity,
  ): StatusChangeFact | null {
    const prevMerged = previous.merged === true;
    const nextMerged = next.attributes.merged === true;
    const identifier =
      typeof next.attributes.identifier === 'string'
        ? next.attributes.identifier
        : next.displayName;
    const occurredAt = new Date().toISOString();

    if (!prevMerged && nextMerged) {
      const baseRef =
        typeof next.attributes.baseRef === 'string' ? next.attributes.baseRef : undefined;
      return {
        summary: baseRef ? `${identifier} merged into ${baseRef}` : `${identifier} merged`,
        occurredAt,
      };
    }

    if (
      !prevMerged &&
      !nextMerged &&
      previous.state !== 'closed' &&
      next.attributes.state === 'closed'
    ) {
      return { summary: `${identifier} closed without merging`, occurredAt };
    }

    return null;
  }

  // --- internals ---------------------------------------------------------

  private credential(ctx: ConnectorContext): Promise<ConnectorCredential> {
    return (this.credentialPromise ??= ctx.getCredential());
  }

  private async repoFullName(ctx: ConnectorContext): Promise<string> {
    const cred = await this.credential(ctx);
    const repo = cred.metadata?.repo;
    if (!repo) {
      throw new Error(
        "GitHubConnector: credential metadata is missing 'repo' — set { repo: 'owner/repo' } " +
          'on the Nango connection backing this engagement (see nango/README.md)',
      );
    }
    return repo;
  }

  private client(ctx: ConnectorContext): Promise<GitHubClient> {
    return (this.clientPromise ??= (async () => {
      const cred = await this.credential(ctx);
      const repo = await this.repoFullName(ctx);
      return this.clientFactory(cred.value, repo);
    })());
  }

  private repository(ctx: ConnectorContext): Promise<GitHubRepository> {
    return (this.repositoryPromise ??= this.client(ctx).then((c) => c.listRepository()));
  }

  private async *stream(ctx: ConnectorContext, cursor: SyncCursor | null): AsyncIterable<SyncEmit> {
    const client = await this.client(ctx);
    const repoFullName = await this.repoFullName(ctx);
    let pageCursor: string | undefined;
    let maxUpdatedAt: string | null = cursor;
    let lastCheckpoint: string | null = cursor;

    do {
      if (ctx.signal.aborted) return;
      const page = await client.listPullRequests({
        updatedSince: cursor ?? undefined,
        cursor: pageCursor,
      });

      for (const pr of page.items) {
        if (ctx.signal.aborted) return;
        yield artifactEmit(this.toArtifact(pr, repoFullName));
        if (!maxUpdatedAt || pr.updatedAt > maxUpdatedAt) maxUpdatedAt = pr.updatedAt;
      }
      pageCursor = page.nextCursor ?? undefined;

      // GitHub's PR list is sorted **ascending** by `updated_at`
      // (`sort=updated&direction=asc`) — the opposite of Linear's
      // newest-first order. That makes a per-page checkpoint a safe low-water
      // mark: every item on this page has already been yielded, and no later
      // page can hold an *older* `updatedAt`. A mid-run crash resumes from the
      // last fully-processed page instead of restarting the whole backfill —
      // strictly better than Linear's one-checkpoint-at-the-end, which is
      // only safe *because* Linear returns newest-first.
      if (maxUpdatedAt && maxUpdatedAt !== lastCheckpoint) {
        yield checkpointEmit(maxUpdatedAt);
        lastCheckpoint = maxUpdatedAt;
      }
    } while (pageCursor);
  }

  private toArtifact(pr: GitHubPullRequest, repoFullName: string): RawArtifact {
    const retain = storesRawBody(this.retentionPolicy);
    const meta: GitHubArtifactMeta = {
      repo: repoFullName,
      number: pr.number,
      title: pr.title,
      state: pr.state,
      merged: pr.merged,
      url: pr.url,
      baseRef: pr.baseRef,
      headRef: pr.headRef,
      updatedAt: pr.updatedAt,
      author: pr.author,
      requestedReviewers: pr.requestedReviewers,
      completedReviewers: pr.completedReviewers,
      decisionRefs: extractDecisionRefs(pr.body),
    };

    return {
      connector: GITHUB_CONNECTOR,
      externalId: pr.id,
      kind: 'issue',
      ...(pr.url ? { urlPermalink: pr.url } : {}),
      occurredAt: pr.createdAt,
      // Body omitted entirely under `reference-only` — no durable copy.
      ...(retain && pr.body ? { body: pr.body } : {}),
      // `raw` carries only re-normalization metadata + the decision markers —
      // never the body text itself (that is `body`, which is what gets
      // field-encrypted or dropped). Keeps `raw` safe to hold under any policy.
      raw: meta as unknown as Record<string, unknown>,
      // Schema-valid placeholder only — the authoritative snapshot comes from
      // the runner calling `resolveAcl(ctx, artifact)` as its own step.
      acl: { rules: [], capturedAt: new Date().toISOString(), ttlSeconds: GITHUB_ACL_TTL_SECONDS },
    };
  }

  private verifySignature(req: ConnectorWebhookRequest): void {
    if (!this.webhookSecret) {
      throw new Error('GitHubConnector.handleWebhook: GITHUB_WEBHOOK_SECRET is not configured');
    }
    const provided = req.headers[GITHUB_WEBHOOK_SIGNATURE_HEADER];
    if (!provided) {
      throw new Error('GitHubConnector.handleWebhook: missing x-hub-signature-256 header');
    }
    const prefix = 'sha256=';
    if (!provided.startsWith(prefix)) {
      throw new Error('GitHubConnector.handleWebhook: malformed x-hub-signature-256 header');
    }
    const expected = createHmac('sha256', this.webhookSecret)
      .update(Buffer.from(req.rawBody))
      .digest();
    const providedBytes = Buffer.from(provided.slice(prefix.length), 'hex');
    if (providedBytes.length !== expected.length || !timingSafeEqual(providedBytes, expected)) {
      throw new Error('GitHubConnector.handleWebhook: bad x-hub-signature-256');
    }
  }
}

/** Map a GitHub `pull_request` webhook's `pull_request` object to the normalized shape. */
function pullRequestFromWebhook(data: Record<string, unknown>): GitHubPullRequest {
  const s = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  const user = (v: unknown): GitHubUser | null => {
    if (!v || typeof v !== 'object') return null;
    const o = v as Record<string, unknown>;
    return o.id !== undefined && o.id !== null
      ? { id: String(o.id), login: s(o.login) ?? '', name: null, email: null }
      : null;
  };
  const now = new Date().toISOString();
  const base = data.base as Record<string, unknown> | undefined;
  const head = data.head as Record<string, unknown> | undefined;
  const requestedReviewers = Array.isArray(data.requested_reviewers)
    ? (data.requested_reviewers as unknown[]).map(user).filter((u): u is GitHubUser => u !== null)
    : [];
  return {
    id: String(data.id ?? ''),
    number: typeof data.number === 'number' ? data.number : 0,
    title: s(data.title) ?? '',
    body: s(data.body),
    state: s(data.state) === 'closed' ? 'closed' : 'open',
    merged: data.merged === true,
    url: s(data.html_url) ?? '',
    baseRef: s(base?.ref) ?? '',
    headRef: s(head?.ref) ?? '',
    createdAt: s(data.created_at) ?? now,
    updatedAt: s(data.updated_at) ?? now,
    author: user(data.user),
    requestedReviewers,
    // webhook payloads carry no review-state data — see `handleWebhook`'s doc comment
    completedReviewers: [],
  };
}
