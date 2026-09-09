import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EngagementId, EvidenceRelation, FactType, TenantId, UserId } from '@fde/core';
import { logAccess } from '@fde/audit';
import { AuthzClient } from '@fde/authz';
import {
  CRYPTO_COLUMNS,
  selectEngagementFacts,
  selectEvidenceForFacts,
  selectNearestChunks,
  selectSourceContext,
} from '@fde/db';
import type { EngagementCipher } from '@fde/crypto';
import { QA_PROMPT_NAME, wrapQaContext, type EmbeddingClient, type Router } from '@fde/llm';

import type { Env } from '../config/env.js';
import { getEngagementContext, getRequestContext } from '../request-context/request-context.js';
import { QUERY_EMBEDDING_CLIENT, ROUTER } from './retrieval.tokens.js';

/** Semantic-KNN fan-out over `embeddings` before the authz gate + the LLM. */
export const QA_CANDIDATE_LIMIT = 8;

const FACTS_PATH = CRYPTO_COLUMNS.facts[0].path;
const EVIDENCE_PATH = CRYPTO_COLUMNS.evidence[0].path;

export interface EvidenceCitation {
  sourceId: string;
  /** `sources.url_permalink` — the citation link target */
  permalink: string | null;
  /** decrypted `evidence.quote` */
  quote: string | null;
  charStart: number | null;
  charEnd: number | null;
  relation: EvidenceRelation;
}

export interface FactRecord {
  id: string;
  type: FactType;
  summary: string;
  /** decrypted `facts.body` */
  body: string | null;
  status: string;
  confidence: number | null;
  occurredAt: string | null;
  createdAt: string;
  citations: EvidenceCitation[];
}

export interface QaCitation {
  sourceId: string;
  permalink: string | null;
  quote: string;
}

export interface QaResult {
  answer: string;
  citations: QaCitation[];
}

/**
 * M4 seam — per-source ACL filtering of retrieval candidates. Today the identity
 * function: M1's only permission gate is the platform-role `canViewEngagement`
 * check (`docs/architecture.md`, read-path step 4). When SpiceDB source-ACL
 * mirroring lands (M4/M5) this drops each candidate whose source the asking user
 * cannot see, still *before* any decryption or the LLM call.
 */
export function filterCandidatesByAcl<T>(_userId: UserId, candidates: T[]): T[] {
  return candidates;
}

/**
 * The engagement read path (`docs/architecture.md` §"Provenance & permission
 * enforcement", step 4).
 *
 * **Transaction / tenant scoping.** This service holds no database code of its
 * own: it reads `tx` from `getRequestContext()` — the transaction
 * `TenantContextInterceptor` already opened via `withEngagement()` (→
 * `withTenant()` → `SET LOCAL ROLE app_rw` + `SET LOCAL app.tenant_id`) — and
 * hands it, with the context `tenantId`, to the `@fde/db` read helpers
 * (`selectEngagementFacts` etc.). Those enforce tenant isolation twice: the
 * `_tenant_isolation` RLS policies **and** an explicit `tenant_id = $tenantId`
 * predicate in every query. Services in this repo never call `withTenant` /
 * `withEngagement` / `createDbClient` themselves (see `request-context.ts` and
 * the sibling `EngagementsController.audit`); doing so would open a nested
 * transaction. Cross-tenant isolation for this exact seam is proven in
 * `seam.integration.test.ts` (tenant A → engagement B → 404) and
 * `retrieval.e2e.test.ts`.
 *
 * `canViewEngagement` is the platform-role gate layered on top of RLS under
 * `AUTHZ_ENFORCE`; 🔒 columns are decrypted only *after* that gate; every
 * content read writes an `access_log` row in the same transaction.
 */
@Injectable()
export class RetrievalService {
  private readonly enforce: boolean;

  constructor(
    @Inject(AuthzClient) private readonly authz: AuthzClient,
    @Inject(ROUTER) private readonly router: Router,
    @Inject(QUERY_EMBEDDING_CLIENT) private readonly embeddingClient: EmbeddingClient,
    @Inject(ConfigService) config: ConfigService<Env, true>,
  ) {
    this.enforce = config.get('AUTHZ_ENFORCE', { infer: true }) === 'true';
  }

  /**
   * This engagement's `facts` newest-first, each with its decrypted `evidence`
   * citations. One `content_read` row is logged in the request transaction.
   */
  async listFacts(): Promise<FactRecord[]> {
    const { tx, userId, tenantId } = getRequestContext();
    const engagement = getEngagementContext();
    await this.assertCanView(userId, tenantId, engagement.id);

    const factRows = await selectEngagementFacts(tx, tenantId, engagement.id);
    const factIds = factRows.map((f) => f.id);
    const evRows = factIds.length
      ? await selectEvidenceForFacts(tx, tenantId, engagement.id, factIds)
      : [];

    await logAccess(tx, {
      tenantId,
      actorType: 'user',
      actorId: userId,
      action: 'content_read',
      engagementId: engagement.id,
      resourceType: 'facts',
      resourceId: engagement.id,
    });

    const out: FactRecord[] = [];
    for (const f of factRows) {
      const citations: EvidenceCitation[] = [];
      for (const e of evRows.filter((e) => e.factId === f.id)) {
        citations.push({
          sourceId: e.sourceId,
          permalink: e.permalink,
          quote: await decrypt(engagement.cipher, EVIDENCE_PATH, e.quote),
          charStart: e.charStart,
          charEnd: e.charEnd,
          relation: e.relation,
        });
      }
      out.push({
        id: f.id,
        type: f.type,
        summary: f.summary,
        body: await decrypt(engagement.cipher, FACTS_PATH, f.body),
        status: f.status,
        confidence: f.confidence,
        occurredAt: f.occurredAt ? f.occurredAt.toISOString() : null,
        createdAt: f.createdAt.toISOString(),
        citations,
      });
    }
    return out;
  }

  /**
   * Single-engagement Q&A: embed the question → pgvector cosine KNN over this
   * engagement's chunk embeddings → **authz gate before the LLM** → decrypt the
   * surviving sources' facts + quotes → answer from that context only. Logs a
   * `retrieval` row and a `content_read` row.
   */
  async answerQuestion(question: string): Promise<QaResult> {
    const { tx, userId, tenantId } = getRequestContext();
    const engagement = getEngagementContext();

    const q = typeof question === 'string' ? question.trim() : '';
    if (!q) throw new BadRequestException('question is required');

    // Query-semantics embedding (asymmetric vs the stored 'document' chunks).
    const [queryVec] = await this.embeddingClient.embed([q]);
    if (!queryVec) throw new BadRequestException('could not embed the question');

    const candidates = await selectNearestChunks(
      tx,
      tenantId,
      engagement.id,
      queryVec,
      QA_CANDIDATE_LIMIT,
    );

    // Authz gate — BEFORE any decryption or the LLM call (read-path step 4).
    await this.assertCanView(userId, tenantId, engagement.id);

    const allowed = filterCandidatesByAcl(userId, candidates);
    const sourceIds = [...new Set(allowed.map((c) => c.sourceId))];
    const context = sourceIds.length
      ? await this.gatherContext(tx, tenantId, engagement, sourceIds)
      : [];

    // Log BEFORE the LLM call: by this point the caller is authorized and the
    // engagement content has been retrieved + decrypted for the prompt, so the
    // read has happened whether or not the model call succeeds. Both rows the
    // architecture read-path calls for; no decrypted content in either —
    // `resourceId` is the engagement id only.
    for (const action of ['retrieval', 'content_read'] as const) {
      await logAccess(tx, {
        tenantId,
        actorType: 'user',
        actorId: userId,
        action,
        engagementId: engagement.id,
        resourceType: action === 'retrieval' ? 'embeddings' : 'facts',
        resourceId: engagement.id,
      });
    }

    const { text } = await this.router.complete({
      prompt: { name: QA_PROMPT_NAME },
      tier: 'default',
      messages: [
        {
          role: 'user',
          content: `Question: ${q}\n\n${wrapQaContext(
            context.map((c) => ({
              permalink: c.permalink,
              facts: c.factSummaries,
              quotes: c.quotes,
            })),
          )}`,
        },
      ],
    });

    return { answer: text, citations: context.flatMap((c) => c.citations) };
  }

  // --- internals -----------------------------------------------------------

  private async assertCanView(
    userId: UserId,
    tenantId: TenantId,
    engagementId: EngagementId,
  ): Promise<void> {
    if (!this.enforce) return;
    // "first observed" parent link — mirrors the audit route; idempotent TOUCH.
    await this.authz.linkEngagementToTenant(engagementId, tenantId);
    if (!(await this.authz.canViewEngagement(userId, engagementId))) {
      throw new ForbiddenException('not authorized to view this engagement');
    }
  }

  /**
   * Post-gate: pull + decrypt the facts/quotes stamped from the surviving
   * sources, grouped by source with a de-duplicated fact summary + quote list.
   */
  private async gatherContext(
    tx: Parameters<typeof selectSourceContext>[0],
    tenantId: TenantId,
    engagement: { id: EngagementId; cipher: EngagementCipher },
    sourceIds: string[],
  ): Promise<ContextSource[]> {
    const rows = await selectSourceContext(tx, tenantId, engagement.id, sourceIds);

    const bySource = new Map<string, ContextSource>();
    for (const r of rows) {
      let entry = bySource.get(r.sourceId);
      if (!entry) {
        entry = {
          sourceId: r.sourceId,
          permalink: r.permalink,
          factSummaries: [],
          quotes: [],
          citations: [],
        };
        bySource.set(r.sourceId, entry);
      }
      const body = await decrypt(engagement.cipher, FACTS_PATH, r.factBody);
      const summary = body ? `${r.factSummary} — ${body}` : r.factSummary;
      if (!entry.factSummaries.includes(summary)) entry.factSummaries.push(summary);

      const quote = await decrypt(engagement.cipher, EVIDENCE_PATH, r.quote);
      if (quote !== null) {
        entry.quotes.push(quote);
        entry.citations.push({ sourceId: r.sourceId, permalink: r.permalink, quote });
      }
    }
    return [...bySource.values()];
  }
}

interface ContextSource {
  sourceId: string;
  permalink: string | null;
  factSummaries: string[];
  quotes: string[];
  citations: QaCitation[];
}

/** Decrypt one 🔒 column value, passing `null`/`undefined` straight through. */
async function decrypt(
  cipher: EngagementCipher,
  path: string,
  value: unknown,
): Promise<string | null> {
  if (value == null) return null;
  return cipher.decryptString(path, value as Parameters<EngagementCipher['decryptString']>[1]);
}
