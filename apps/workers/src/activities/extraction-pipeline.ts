import { ApplicationFailure, heartbeat } from '@temporalio/activity';
import { and, eq } from 'drizzle-orm';

import type { EngagementId, RetentionPolicy, SourceId, TenantId } from '@fde/core';
import { decryptRow, encryptRow, EngagementShreddedError, type KeyProvider } from '@fde/crypto';
import {
  captureSessions,
  CRYPTO_COLUMNS,
  embeddings,
  evidence,
  extractionRuns,
  facts,
  sources,
  type Database,
} from '@fde/db';
import {
  EXTRACTION_PROMPT_NAME,
  extractionJsonSchema,
  extractionResultSchema,
  getPrompt,
  NoopTracer,
  redactUsage,
  sha256Hex,
  StructuredOutputError,
  traceExtraction,
  wrapTranscript,
  type EmbeddingClient,
  type Router,
  type Tracer,
} from '@fde/llm';

import { chunkTranscript, type ChunkOptions } from './chunk-transcript.js';
import { withEngagementActivity } from './engagement-context.js';
import { REPROCESSING_WINDOW_MS } from './transcript-source.js';

export interface ExtractionActivitiesDeps {
  db: Database;
  keyProvider: KeyProvider;
  router: Router;
  embeddingClient: EmbeddingClient;
  /** redacted run tracing; defaults to `NoopTracer` (tracing is optional) */
  tracer?: Tracer;
}

export interface RunExtractionInput {
  tenantId: TenantId;
  engagementId: EngagementId;
  sourceId: string;
  /** workflow-generated — an activity retry redoes the run idempotently against this id */
  extractionRunId: string;
  /** pin a specific registered extraction prompt version; defaults to the latest */
  promptVersion?: string;
  chunking?: ChunkOptions;
}

export interface RunExtractionResult {
  retentionPolicy: RetentionPolicy;
  /** ISO-8601 wall-clock after which the raw body should be purged, or null */
  purgeRawAfter: string | null;
  factCount: number;
  chunkCount: number;
  embeddingCount: number;
  usdCost: number;
  /** metadata-only: number of model extraction calls (one per chunk) */
  modelCallCount: number;
  /** metadata-only: model evidence spans that did not match the source verbatim (stored as null spans) */
  unlocatableSpanCount: number;
}

export interface PurgeRawBodyInput {
  tenantId: TenantId;
  engagementId: EngagementId;
  sourceId: string;
  extractionRunId: string;
}

export interface PurgeRawBodyResult {
  purged: boolean;
}

/**
 * The `ExtractionPipeline` activities. DI point for `db` / `keyProvider` /
 * `router` / `embeddingClient` (all fake-able — see the tests; no API keys are
 * needed to exercise this).
 *
 * Ids-only payloads: the workflow hands `runExtractionActivity` `{ tenantId,
 * engagementId, sourceId, extractionRunId }`. The transcript plaintext and every
 * chunk are read, embedded, and extracted-from *entirely inside* this one
 * activity — they never cross the workflow↔activity boundary or land in workflow
 * history (`docs/architecture.md`: "Temporal payloads carry ids, never bodies").
 */
export function createExtractionActivities(deps: ExtractionActivitiesDeps) {
  const tracer = deps.tracer ?? new NoopTracer();

  async function runExtractionActivity(input: RunExtractionInput): Promise<RunExtractionResult> {
    const { tenantId, engagementId, sourceId, extractionRunId } = input;

    // Per-run usage accumulator (metadata only — cost + call count). The
    // router's `onUsage` sink (wired in worker.ts) is the process-wide
    // observability seam that #11 (Langfuse) attaches to; this per-run tally is
    // summed from each `router.extract()` result instead, so concurrent runs on
    // a shared router never cross-contaminate.
    const usage = { calls: 0, costUsd: 0 };

    const promptVersion = getPrompt(EXTRACTION_PROMPT_NAME, input.promptVersion).version;
    const bulkModel = deps.router.provider.modelForTier('bulk');

    // One redacted trace per run: per-chunk generations (usage fields + coarse
    // outcome) under one `extraction.run` trace, closed with the run tally. All
    // metadata — no transcript, no model output, no fact/evidence bodies.
    const outcome = await traceExtraction(tracer, { extractionRunId, sourceId }, async (trace) => {
      const inner = await withEngagementActivity(
        deps.db,
        deps.keyProvider,
        { tenantId, engagementId },
        // One `ctx.tx` transaction wraps the whole activity call — acceptable for a
        // single meeting transcript. Very large transcripts should fan out into
        // multiple activities (a chunk range each) so no one transaction is held
        // open across many model calls; that is a documented later refinement.
        async (ctx) => {
          const [srcRow] = await ctx.tx
            .select({ rawBody: sources.rawBody, retentionPolicy: sources.retentionPolicy })
            .from(sources)
            .where(and(eq(sources.id, sourceId), eq(sources.engagementId, engagementId)))
            .limit(1);
          if (!srcRow) {
            throw ApplicationFailure.create({
              type: 'SourceNotFound',
              message: `source ${sourceId} not found in engagement`,
              nonRetryable: true,
            });
          }
          if (srcRow.rawBody == null) {
            // Reference-only (or an already-purged) source: there is no retained
            // body to extract from here. Seam: reference-only transcripts are
            // extracted inline at capture time against the fetched-but-unstored
            // body — a later iteration, not this workflow.
            throw ApplicationFailure.create({
              type: 'NoRetainedBody',
              message:
                'no retained body to extract; reference-only transcripts are extracted inline at capture — later iteration',
              nonRetryable: true,
            });
          }
          const retentionPolicy = srcRow.retentionPolicy as RetentionPolicy;
          const { rawBody: plaintext } = await decryptRow<{ rawBody: string }>(
            ctx.cipher,
            CRYPTO_COLUMNS.sources,
            srcRow,
          );

          // v1 idempotency: wipe anything a previous (crashed) attempt of THIS run
          // wrote, then redo the whole extraction. Chunk-level partial-progress
          // resume is a documented later refinement — no per-chunk bookkeeping here.
          // This makes an *activity retry* (same `extractionRunId`) safe. Two
          // *distinct* runs for one source running concurrently is not guarded —
          // dispatch extraction for a given source serially; a `sources`-level
          // "extraction in progress" guard is a later refinement.
          await ctx.tx
            .delete(evidence)
            .where(
              and(
                eq(evidence.engagementId, engagementId),
                eq(evidence.extractionRunId, extractionRunId),
              ),
            );
          await ctx.tx
            .delete(facts)
            .where(
              and(eq(facts.engagementId, engagementId), eq(facts.extractionRunId, extractionRunId)),
            );
          // `embeddings` carries no extraction_run_id (see the schema). This
          // activity is the sole producer of embeddings for a transcript source
          // and re-embeds the whole source each run, so "all embeddings for this
          // source" is the idempotent unit. A per-run embeddings stamp is a later
          // refinement if concurrent runs per source ever appear.
          await ctx.tx
            .delete(embeddings)
            .where(
              and(eq(embeddings.engagementId, engagementId), eq(embeddings.sourceId, sourceId)),
            );

          await ctx.tx
            .insert(extractionRuns)
            .values({
              id: extractionRunId,
              tenantId,
              engagementId,
              model: bulkModel,
              promptVersion,
              inputSourceIds: [sourceId],
            })
            .onConflictDoNothing();

          // One extraction call per chunk. A fact restated in the overlap between
          // two chunks can be extracted twice — cross-chunk fact dedup (by span /
          // semantic key) is a documented later refinement, tracked with the
          // token-aware chunking work.
          const chunks = chunkTranscript(plaintext, input.chunking);
          let factCount = 0;
          let embeddingCount = 0;
          let unlocatableSpanCount = 0;

          // One extraction call, metered + traced. The redacted per-chunk
          // generation carries usage fields + a hash of the chunk — never the
          // chunk text or the model's output. A failed call is still recorded
          // (coarse outcome) before it propagates.
          const extractChunk = async (chunkText: string) => {
            const inputHash = sha256Hex(chunkText);
            try {
              const result = await deps.router.extract(extractionResultSchema, {
                prompt: { name: EXTRACTION_PROMPT_NAME, version: promptVersion },
                jsonSchema: extractionJsonSchema,
                schemaName: 'extraction_result',
                tier: 'bulk',
                messages: wrapTranscript(chunkText),
              });
              usage.calls += 1;
              usage.costUsd += result.usage.costUsd;
              trace.generation(
                redactUsage(result.usage, {
                  name: 'extraction.chunk',
                  promptName: EXTRACTION_PROMPT_NAME,
                  outcome: 'ok',
                  inputHash,
                }),
              );
              return result.value;
            } catch (err) {
              const tokenUsage = err instanceof StructuredOutputError ? err.usage : undefined;
              trace.generation({
                name: 'extraction.chunk',
                provider: deps.router.provider.name,
                model: bulkModel,
                tier: 'bulk',
                promptName: EXTRACTION_PROMPT_NAME,
                promptVersion,
                inputTokens: tokenUsage?.inputTokens ?? 0,
                outputTokens: tokenUsage?.outputTokens ?? 0,
                cacheReadInputTokens: tokenUsage?.cacheReadInputTokens ?? 0,
                cacheCreationInputTokens: tokenUsage?.cacheCreationInputTokens ?? 0,
                costUsd: 0,
                latencyMs: 0,
                outcome: err instanceof StructuredOutputError ? 'schema-fail' : 'provider-error',
                inputHash,
              });
              throw err;
            }
          };

          for (const chunk of chunks) {
            heartbeat();

            const extracted = await extractChunk(chunk.text);

            const [vector] = await deps.embeddingClient.embed([chunk.text]);
            await ctx.tx.insert(embeddings).values({
              tenantId,
              engagementId,
              sourceId: sourceId as SourceId,
              chunkRef: chunk.ref,
              model: deps.embeddingClient.model,
              embedding: vector!,
            });
            embeddingCount += 1;

            for (const fact of extracted.facts) {
              const factRow = await encryptRow(ctx.cipher, CRYPTO_COLUMNS.facts, {
                body: fact.detail ?? null,
              });
              const [insertedFact] = await ctx.tx
                .insert(facts)
                .values({
                  tenantId,
                  engagementId,
                  type: fact.type,
                  summary: fact.summary,
                  body: factRow.body ?? null,
                  confidence: fact.confidence,
                  occurredAt: fact.occurredAt ? new Date(fact.occurredAt) : null,
                  extractionRunId,
                })
                .returning({ id: facts.id });
              const factId = insertedFact!.id;
              factCount += 1;

              for (const ev of fact.evidence) {
                // Translate the model's chunk-local span to a source-document span,
                // and keep it only if it quotes the source verbatim.
                let charStart: number | null = null;
                let charEnd: number | null = null;
                if (ev.charStart !== undefined && ev.charEnd !== undefined) {
                  const s = ev.charStart + chunk.offset;
                  const e = ev.charEnd + chunk.offset;
                  // The zod refinement should already guarantee `0 <= s < e`, but
                  // the model output is untrusted — bound-check before slicing so
                  // a bad span is dropped, never wrapped (`slice(-n)`) or silently
                  // clamped into a false match.
                  if (
                    s >= 0 &&
                    e <= plaintext.length &&
                    s < e &&
                    plaintext.slice(s, e) === ev.quote
                  ) {
                    charStart = s;
                    charEnd = e;
                  } else {
                    unlocatableSpanCount += 1;
                  }
                }
                const evRow = await encryptRow(ctx.cipher, CRYPTO_COLUMNS.evidence, {
                  quote: ev.quote,
                });
                await ctx.tx.insert(evidence).values({
                  tenantId,
                  engagementId,
                  factId,
                  sourceId,
                  quote: evRow.quote,
                  charStart,
                  charEnd,
                  relation: ev.relation,
                  extractionRunId,
                });
              }
            }
          }

          await ctx.tx
            .update(extractionRuns)
            .set({ costUsd: usage.costUsd })
            .where(
              and(
                eq(extractionRuns.id, extractionRunId),
                eq(extractionRuns.engagementId, engagementId),
              ),
            );

          // Purge deadline: the `capture_sessions` marker for this source if there
          // is one, else derive it from the policy (capture is the only wiring
          // today; other connectors are M2+).
          const [cs] = await ctx.tx
            .select({ purgeRawAfter: captureSessions.purgeRawAfter })
            .from(captureSessions)
            .where(
              and(
                eq(captureSessions.engagementId, engagementId),
                eq(captureSessions.sourceId, sourceId),
              ),
            )
            .limit(1);
          const purgeRawAfter =
            retentionPolicy === 'derived-ephemeral-raw'
              ? (cs?.purgeRawAfter ?? new Date(Date.now() + REPROCESSING_WINDOW_MS)).toISOString()
              : null;

          return {
            retentionPolicy,
            purgeRawAfter,
            factCount,
            chunkCount: chunks.length,
            embeddingCount,
            unlocatableSpanCount,
          };
        },
      );

      // Redacted run end: counts + cost only.
      trace.end({
        chunkCount: inner.chunkCount,
        factCount: inner.factCount,
        embeddingCount: inner.embeddingCount,
        unlocatableSpanCount: inner.unlocatableSpanCount,
        usdCost: usage.costUsd,
        okChunks: usage.calls,
      });
      return inner;
    });

    return { ...outcome, usdCost: usage.costUsd, modelCallCount: usage.calls };
  }

  /**
   * Null `sources.raw_body` for a `derived-ephemeral-raw` source once extraction
   * has landed and the reprocessing window has closed. Two independent guards,
   * both required:
   *
   * 1. **This run completed and extracted this source** — an `extraction_runs`
   *    row for `extractionRunId` exists in the engagement, lists `sourceId` in
   *    `input_source_ids`, AND has a non-null `cost_usd`. `runExtractionActivity`
   *    does all of its writes in one transaction and sets `cost_usd` as the very
   *    last statement, so `cost_usd IS NOT NULL` marks a fully-committed run even
   *    if the activity is later split across transactions. A crashed attempt
   *    rolls back entirely and leaves no row.
   * 2. `now >= capture_sessions.purge_raw_after` when the source came from a
   *    capture session (the workflow's durable timer already enforced this; the
   *    check is defence in depth against a mis-fired timer).
   *
   * Runs inside `withEngagementActivity` — no plaintext is touched (it only
   * NULLs a ciphertext column), but going through the engagement path gives
   * tenant + engagement RLS scoping AND the `FOR SHARE` lock on the engagement
   * row, so a purge can never race a concurrent crypto-shred. If the engagement
   * has already been shredded, `raw_body` is permanently unreadable regardless —
   * there is nothing to purge, so that is a no-op, not a failure.
   */
  async function purgeRawBodyActivity(input: PurgeRawBodyInput): Promise<PurgeRawBodyResult> {
    const { tenantId, engagementId, sourceId, extractionRunId } = input;
    try {
      return await withEngagementActivity(
        deps.db,
        deps.keyProvider,
        { tenantId, engagementId },
        async (ctx) => {
          const [run] = await ctx.tx
            .select({
              inputSourceIds: extractionRuns.inputSourceIds,
              costUsd: extractionRuns.costUsd,
            })
            .from(extractionRuns)
            .where(
              and(
                eq(extractionRuns.id, extractionRunId),
                eq(extractionRuns.engagementId, engagementId),
              ),
            )
            .limit(1);
          // No completed run for this id, it did not extract this source, or it
          // never reached its final write → never purge (the raw body is the only
          // copy).
          if (run?.costUsd == null || !run.inputSourceIds.includes(sourceId)) {
            return { purged: false };
          }

          const [cs] = await ctx.tx
            .select({ purgeRawAfter: captureSessions.purgeRawAfter })
            .from(captureSessions)
            .where(
              and(
                eq(captureSessions.engagementId, engagementId),
                eq(captureSessions.sourceId, sourceId),
              ),
            )
            .limit(1);
          if (cs?.purgeRawAfter && Date.now() < cs.purgeRawAfter.getTime())
            return { purged: false };

          const updated = await ctx.tx
            .update(sources)
            .set({ rawBody: null })
            .where(and(eq(sources.id, sourceId), eq(sources.engagementId, engagementId)))
            .returning({ id: sources.id });
          return { purged: updated.length > 0 };
        },
      );
    } catch (err) {
      if (err instanceof EngagementShreddedError) return { purged: false };
      throw err;
    }
  }

  return { runExtractionActivity, purgeRawBodyActivity };
}

export type ExtractionActivities = ReturnType<typeof createExtractionActivities>;
