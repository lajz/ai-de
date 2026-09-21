import { ApplicationFailure, log } from '@temporalio/activity';

import type { EngagementId, TenantId } from '@fde/core';
import { decryptRow, type KeyProvider } from '@fde/crypto';
import {
  AGENTIC_LINKING_CANDIDATE_LIMIT,
  CRYPTO_COLUMNS,
  resolveEndpointRef,
  selectCandidateFactsBySourceIds,
  selectEntityForProvenance,
  selectNearestChunks,
  selectOtherWorkItemEntitiesForIdentifierScan,
  selectSourceRefsByIds,
  selectWorkItemEntityForLinking,
  upsertRelationship,
  type Database,
} from '@fde/db';
import {
  AGENTIC_LINKING_PROMPT_NAME,
  agenticLinkingJsonSchema,
  agenticLinkingResultSchema,
  getPrompt,
  NoopTracer,
  redactUsage,
  StructuredOutputError,
  wrapAgenticLinkingContext,
  type AgenticLinkingCandidateInput,
  type EmbeddingClient,
  type Router,
  type Tracer,
} from '@fde/llm';

import { withEngagementActivity } from './engagement-context.js';

export interface AgenticLinkingActivitiesDeps {
  db: Database;
  keyProvider: KeyProvider;
  router: Router;
  /**
   * Query-semantics embedding client (`inputType: 'query'`) — the work item's
   * own text is a query against the stored ('document'-typed) chunk
   * embeddings, same asymmetric-embedding split `apps/api`'s Q&A path uses via
   * `QUERY_EMBEDDING_CLIENT`. Deliberately a *separate* client instance from
   * the workers' extraction-pipeline `embeddingClient` (which embeds stored
   * chunks with `inputType: 'document'`).
   */
  embeddingClient: EmbeddingClient;
  /** redacted LLM tracing; defaults to `NoopTracer` (tracing is optional) */
  tracer?: Tracer;
}

export interface RunAgenticLinkingInput {
  tenantId: TenantId;
  engagementId: EngagementId;
  /** the newly-created `work_item` entity to find links for */
  workItemEntityId: string;
  /** the `sources` row that landed this work item — stamped onto every edge written */
  sourceId: string;
}

export interface RunAgenticLinkingResult {
  /** other work items matched by a literal identifier reference in the title/body */
  identifierMatches: number;
  /** semantic candidates handed to the LLM judgment call (0 when nothing embedded is nearby) */
  semanticCandidates: number;
  /** `relates_to` edges actually inserted (dedupe hits + below-threshold candidates excluded) */
  edgesWritten: number;
}

/**
 * Confidence bar for auto-writing a semantic-candidate edge. 0.7 is a
 * deliberately conservative starting point for a v1 with no human review step
 * and no retry/reconsideration pass — a candidate the model itself is not
 * fairly confident about is discarded outright, not queued, not written at a
 * lower confidence. Tune against what `agentic-linking`'s judgment prompt
 * actually returns in practice; there is no queue to catch a threshold set
 * too low.
 */
export const AGENTIC_LINKING_CONFIDENCE_THRESHOLD = 0.7;

/** Linear/Jira-style ticket key, e.g. `ENG-42`. */
const TICKET_KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,6}\b/g;
/** GitHub-style repo-qualified PR/issue reference, e.g. `acme/widgets#123`. */
const REPO_PR_RE = /\b[\w.-]+\/[\w.-]+#\d{1,6}\b/g;
/** Bound the regex scan on a pathologically long body — titles/bodies are already small in practice. */
const MAX_SCAN_CHARS = 5000;

/**
 * Regex-extract plausible ticket keys from free text — Signal 1 of
 * `AgenticLinkingPipeline`. Pure and unit-tested directly.
 *
 * Known shape, documented rather than "fixed" (the identifier LOOKUP after
 * extraction is what actually filters most of this — a candidate key that
 * isn't any real work item's identifier writes nothing):
 * - False positives: the ticket-key pattern matches any all-caps
 *   letters-hyphen-digits token, not just a real tracker key — a version
 *   string, a CSS class, `UTC-5`. Harmless unless that exact string also
 *   happens to be another work item's real identifier.
 * - False negatives: a lowercase key, a key split across a line break, or an
 *   informal cross-reference ("see PR 42", no `#`) are not caught. Only the
 *   title + body at creation time are scanned — a key added in a later edit
 *   or a comment is out of v1's scope (create-time only, matching the
 *   pipeline's overall trigger).
 */
export function extractTicketKeys(text: string): string[] {
  if (!text) return [];
  const bounded = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const out = new Set<string>();
  for (const m of bounded.match(TICKET_KEY_RE) ?? []) out.add(m);
  for (const m of bounded.match(REPO_PR_RE) ?? []) out.add(m);
  return [...out];
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * `AgenticLinkingPipeline`'s one activity: identifier scan (deterministic) +
 * semantic candidate gather + LLM judgment + edge writes, for one newly
 * created work item. DI point for `db` / `keyProvider` / `router` /
 * `embeddingClient` / `tracer` (all fake-able — no API keys needed to
 * exercise this, same as `createExtractionActivities`).
 *
 * Structured as several short `withEngagementActivity` transactions around
 * the two network calls (the embed, the LLM judgment) — never one transaction
 * held open across a network round trip — the same split
 * `ConnectorSync.ingestArtifact` / `makeGetCredential` use for `resolveAcl` /
 * the Nango token exchange.
 */
export function createAgenticLinkingActivities(deps: AgenticLinkingActivitiesDeps) {
  const tracer = deps.tracer ?? new NoopTracer();

  async function runAgenticLinkingActivity(
    input: RunAgenticLinkingInput,
  ): Promise<RunAgenticLinkingResult> {
    const { tenantId, engagementId, workItemEntityId, sourceId } = input;

    // --- load the work item + run the identifier scan (DB-only) ----------
    const loaded = await withEngagementActivity(
      deps.db,
      deps.keyProvider,
      { tenantId, engagementId },
      async (ctx) => {
        const row = await selectWorkItemEntityForLinking(
          ctx.tx,
          tenantId,
          engagementId,
          workItemEntityId,
        );
        if (!row) {
          throw ApplicationFailure.create({
            type: 'WorkItemNotFound',
            message: `work item entity ${workItemEntityId} not found in engagement ${engagementId}`,
            nonRetryable: true,
          });
        }
        const decrypted = await decryptRow<{
          attributes: Record<string, unknown>;
          body: string | null;
        }>(ctx.cipher, CRYPTO_COLUMNS.entities, { attributes: row.attributes, body: row.body });
        const title = row.displayName;
        const body = decrypted.body ?? '';

        const candidateKeys = extractTicketKeys(`${title}\n${body}`);
        const identifierMatchIds: string[] = [];
        if (candidateKeys.length > 0) {
          const others = await selectOtherWorkItemEntitiesForIdentifierScan(
            ctx.tx,
            tenantId,
            engagementId,
            workItemEntityId,
          );
          for (const other of others) {
            const otherAttrs = await ctx.cipher.decryptJson<Record<string, unknown>>(
              CRYPTO_COLUMNS.entities[0].path,
              other.attributes,
            );
            const otherIdentifier =
              typeof otherAttrs.identifier === 'string' ? otherAttrs.identifier : null;
            if (otherIdentifier && candidateKeys.some((k) => norm(k) === norm(otherIdentifier))) {
              identifierMatchIds.push(other.id);
            }
          }
        }

        return { title, body, identifierMatchIds };
      },
    );

    // --- embed the work item's text (network, outside any DB lock) -------
    const text = `${loaded.title}\n${loaded.body}`.trim();
    const [queryVec] = text.length > 0 ? await deps.embeddingClient.embed([text]) : [];

    // --- gather semantic candidates (DB-only) -----------------------------
    const semantic: AgenticLinkingCandidateInput[] = queryVec
      ? await withEngagementActivity(
          deps.db,
          deps.keyProvider,
          { tenantId, engagementId },
          async (ctx) => {
            const chunkHits = await selectNearestChunks(
              ctx.tx,
              tenantId,
              engagementId,
              queryVec,
              AGENTIC_LINKING_CANDIDATE_LIMIT,
            );
            const candidateSourceIds = [
              ...new Set(chunkHits.map((h) => h.sourceId).filter((id) => id !== sourceId)),
            ];
            if (candidateSourceIds.length === 0) return [];

            const factRows = await selectCandidateFactsBySourceIds(
              ctx.tx,
              tenantId,
              engagementId,
              candidateSourceIds,
            );
            const factCandidates: AgenticLinkingCandidateInput[] = [];
            for (const f of factRows) {
              const body =
                f.body != null
                  ? await ctx.cipher.decryptString(CRYPTO_COLUMNS.facts[0].path, f.body)
                  : null;
              factCandidates.push({
                id: f.id,
                kind: 'fact',
                label: body ? `${f.type}: ${f.summary} — ${body}` : `${f.type}: ${f.summary}`,
              });
            }

            // Other work_item entities behind these sources — reachable only if a
            // future connector's body ever gets chunked/embedded (today only
            // meeting transcripts are, so this is typically empty; see the PR
            // description's v1-scope note).
            const sourceRefs = await selectSourceRefsByIds(
              ctx.tx,
              tenantId,
              engagementId,
              candidateSourceIds,
            );
            const entityCandidates: AgenticLinkingCandidateInput[] = [];
            for (const ref of sourceRefs) {
              const resolved = await resolveEndpointRef(ctx.tx, tenantId, engagementId, {
                connector: ref.connector,
                externalId: ref.externalId,
              });
              if (!resolved || resolved.kind !== 'entity' || resolved.id === workItemEntityId) {
                continue;
              }
              if (entityCandidates.some((c) => c.id === resolved.id)) continue;
              const entity = await selectEntityForProvenance(
                ctx.tx,
                tenantId,
                engagementId,
                resolved.id,
              );
              if (entity?.type === 'work_item') {
                entityCandidates.push({ id: entity.id, kind: 'entity', label: entity.displayName });
              }
            }

            return [...factCandidates, ...entityCandidates].slice(
              0,
              AGENTIC_LINKING_CANDIDATE_LIMIT,
            );
          },
        )
      : [];

    // --- LLM judgment over the semantic candidates (network) -------------
    const approvedSemantic: { candidateId: string; confidence: number }[] = [];
    if (semantic.length > 0) {
      const promptVersion = getPrompt(AGENTIC_LINKING_PROMPT_NAME).version;
      const trace = tracer.startTrace({ name: 'agentic_linking.run', sourceId });
      try {
        const result = await deps.router.extract(agenticLinkingResultSchema, {
          prompt: { name: AGENTIC_LINKING_PROMPT_NAME },
          jsonSchema: agenticLinkingJsonSchema,
          schemaName: 'agentic_linking_result',
          tier: 'bulk',
          messages: [
            {
              role: 'user',
              content: wrapAgenticLinkingContext(
                { title: loaded.title, body: loaded.body },
                semantic,
              ),
            },
          ],
        });
        trace.generation(
          redactUsage(result.usage, {
            name: 'agentic_linking.judgment',
            promptName: AGENTIC_LINKING_PROMPT_NAME,
            outcome: 'ok',
          }),
        );
        const byId = new Set(semantic.map((c) => c.id));
        for (const j of result.value.judgments) {
          // Ignore an id the model wasn't actually offered — never trust
          // structured output to only reference what it was given.
          if (!byId.has(j.candidateId)) continue;
          if (j.relates && j.confidence >= AGENTIC_LINKING_CONFIDENCE_THRESHOLD) {
            approvedSemantic.push({ candidateId: j.candidateId, confidence: j.confidence });
          }
        }
      } catch (err) {
        // Best-effort: a judgment failure (schema-fail, provider error) means
        // no semantic edges get written this run — never fails the workflow.
        // The identifier-match edges (deterministic, already computed) still
        // land below.
        const message = err instanceof Error ? err.message : String(err);
        log.warn('agentic_linking.judgment_failed', { message });
        trace.generation({
          name: 'agentic_linking.judgment',
          provider: deps.router.provider.name,
          model: deps.router.provider.modelForTier('bulk'),
          tier: 'bulk',
          promptName: AGENTIC_LINKING_PROMPT_NAME,
          promptVersion,
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          costUsd: 0,
          latencyMs: 0,
          outcome: err instanceof StructuredOutputError ? 'schema-fail' : 'provider-error',
        });
      } finally {
        trace.end();
      }
    }

    // --- write edges (DB-only) --------------------------------------------
    return withEngagementActivity(
      deps.db,
      deps.keyProvider,
      { tenantId, engagementId },
      async (ctx) => {
        let edgesWritten = 0;

        // Signal 1 — identifier match. Deterministic: no confidence stamped,
        // same null-vs-populated convention `facts.confidence` already uses.
        for (const targetId of loaded.identifierMatchIds) {
          const { inserted } = await upsertRelationship(ctx.tx, tenantId, engagementId, {
            fromKind: 'entity',
            fromId: workItemEntityId,
            predicate: 'relates_to',
            toKind: 'entity',
            toId: targetId,
            sourceId,
          });
          if (inserted) edgesWritten += 1;
        }

        // Signal 2 — LLM-approved semantic candidates, confidence stamped.
        for (const approved of approvedSemantic) {
          const candidate = semantic.find((c) => c.id === approved.candidateId);
          if (!candidate) continue;
          const { inserted } = await upsertRelationship(ctx.tx, tenantId, engagementId, {
            fromKind: 'entity',
            fromId: workItemEntityId,
            predicate: 'relates_to',
            toKind: candidate.kind,
            toId: candidate.id,
            sourceId,
            confidence: approved.confidence,
          });
          if (inserted) edgesWritten += 1;
        }

        return {
          identifierMatches: loaded.identifierMatchIds.length,
          semanticCandidates: semantic.length,
          edgesWritten,
        };
      },
    );
  }

  return { runAgenticLinkingActivity };
}

export type AgenticLinkingActivities = ReturnType<typeof createAgenticLinkingActivities>;
