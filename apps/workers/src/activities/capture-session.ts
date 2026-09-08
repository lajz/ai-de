import type { EngagementId, RetentionPolicy, SourceId, TenantId } from '@fde/core';
import type { KeyProvider } from '@fde/crypto';
import { captureSessions, sources, withTenant, type Database } from '@fde/db';
import { and, eq } from 'drizzle-orm';

import type { CaptureBotStatus, RecallClient } from '../capture/recall-client.js';
import { withEngagementActivity } from './engagement-context.js';
import {
  RECALL_CONNECTOR,
  REPROCESSING_WINDOW_MS,
  buildTranscriptSource,
} from './transcript-source.js';

export interface CaptureSessionActivitiesDeps {
  db: Database;
  keyProvider: KeyProvider;
  recallClient: RecallClient;
}

export interface ScheduleCaptureBotInput {
  tenantId: TenantId;
  engagementId: EngagementId;
  /** workflow-generated id, so a retry of this activity is idempotent */
  captureSessionId: string;
  meetingUrl: string;
  joinAt: string;
  retentionPolicy: RetentionPolicy;
}

export interface ScheduleCaptureBotResult {
  captureSessionId: string;
  botId: string;
}

export interface PollCaptureBotInput {
  botId: string;
}

export interface PollCaptureBotResult {
  botId: string;
  status: CaptureBotStatus;
  failureReason?: string;
}

export interface StoreTranscriptSourceInput {
  tenantId: TenantId;
  engagementId: EngagementId;
  captureSessionId: string;
  botId: string;
  meetingUrl: string;
  joinAt: string;
  retentionPolicy: RetentionPolicy;
}

export interface StoreTranscriptSourceResult {
  captureSessionId: string;
  sourceId: SourceId;
  /** true when the encrypted transcript body was persisted (policy ≠ reference-only) */
  bodyRetained: boolean;
  transcriptChars: number;
}

/**
 * The `CaptureSession` activities. DI point for `db` / `keyProvider` /
 * `recallClient` (`FakeRecallClient` in tests + local dev, `HttpRecallClient`
 * once `RECALL_API_KEY` is set).
 *
 * Ids-only payloads: the workflow hands each activity `{ tenantId, engagementId,
 * … }` and a meeting URL — never the transcript body. `storeTranscriptSource` is
 * where the body enters the process (from Recall) and is immediately encrypted
 * with the engagement DEK before it reaches Postgres.
 */
export function createCaptureSessionActivities(deps: CaptureSessionActivitiesDeps) {
  const sessionRef = (i: { tenantId: TenantId; captureSessionId: string }) =>
    and(eq(captureSessions.id, i.captureSessionId), eq(captureSessions.tenantId, i.tenantId));

  async function scheduleCaptureBotActivity(
    input: ScheduleCaptureBotInput,
  ): Promise<ScheduleCaptureBotResult> {
    // Create the tracking row on the first attempt; on a retry, reuse whatever
    // the previous attempt got as far as.
    const priorBotId = await withTenant(deps.db, input.tenantId, async (tx) => {
      const [existing] = await tx
        .select({ botId: captureSessions.botId })
        .from(captureSessions)
        .where(sessionRef(input))
        .limit(1);
      if (existing) return existing.botId;
      await tx.insert(captureSessions).values({
        id: input.captureSessionId,
        tenantId: input.tenantId,
        engagementId: input.engagementId,
        meetingUrl: input.meetingUrl,
        joinAt: new Date(input.joinAt),
        status: 'scheduled',
        retentionPolicy: input.retentionPolicy,
      });
      return null;
    });
    if (priorBotId) return { captureSessionId: input.captureSessionId, botId: priorBotId };

    // Narrow (not zero) window: if scheduleBot succeeds but the UPDATE below
    // fails, a retry schedules a second bot. Recall has no create-idempotency
    // key today; the follow-up UPDATE is a single trivial statement. Documented
    // seam: dedupe on (meetingUrl, joinAt) once Recall supports it.
    const { botId } = await deps.recallClient.scheduleBot({
      meetingUrl: input.meetingUrl,
      joinAt: input.joinAt,
    });

    await withTenant(deps.db, input.tenantId, (tx) =>
      tx.update(captureSessions).set({ botId, updatedAt: new Date() }).where(sessionRef(input)),
    );
    return { captureSessionId: input.captureSessionId, botId };
  }

  async function pollCaptureBotActivity(input: PollCaptureBotInput): Promise<PollCaptureBotResult> {
    const state = await deps.recallClient.getBot(input.botId);
    return {
      botId: state.botId,
      status: state.status,
      ...(state.failureReason ? { failureReason: state.failureReason } : {}),
    };
  }

  async function storeTranscriptSourceActivity(
    input: StoreTranscriptSourceInput,
  ): Promise<StoreTranscriptSourceResult> {
    // The transcript body enters the process here and nowhere else.
    const segments = await deps.recallClient.getTranscript(input.botId);
    if (segments.length === 0) {
      // Recall reported the bot `done` but handed back nothing — almost always a
      // premature read (the transcript is still finalizing). Retryable: the
      // activity's retry policy re-fetches after a backoff.
      throw new Error(`transcript for bot ${input.botId} is empty; not yet available`);
    }

    return withEngagementActivity(
      deps.db,
      deps.keyProvider,
      { tenantId: input.tenantId, engagementId: input.engagementId },
      async (ctx) => {
        const built = await buildTranscriptSource(ctx.cipher, {
          tenantId: input.tenantId,
          engagementId: input.engagementId,
          botId: input.botId,
          meetingUrl: input.meetingUrl,
          occurredAt: input.joinAt,
          segments,
          retentionPolicy: input.retentionPolicy,
        });

        const [inserted] = await ctx.tx
          .insert(sources)
          .values(built.row)
          .onConflictDoNothing({
            target: [
              sources.engagementId,
              sources.connector,
              sources.externalId,
              sources.contentHash,
            ],
          })
          .returning({ id: sources.id });

        // On a retry the row already exists (dedupe hit) — look it up.
        const sourceId =
          inserted?.id ??
          (
            await ctx.tx
              .select({ id: sources.id })
              .from(sources)
              .where(
                and(
                  eq(sources.engagementId, input.engagementId),
                  eq(sources.connector, RECALL_CONNECTOR),
                  eq(sources.externalId, input.botId),
                ),
              )
              .limit(1)
          )[0]?.id;
        if (!sourceId) throw new Error('storeTranscriptSource: source row missing after upsert');

        const purgeRawAfter =
          input.retentionPolicy === 'derived-ephemeral-raw'
            ? new Date(Date.now() + REPROCESSING_WINDOW_MS)
            : null;

        await ctx.tx
          .update(captureSessions)
          .set({ status: 'captured', sourceId, purgeRawAfter, updatedAt: new Date() })
          .where(sessionRef(input));

        // Under `derived-ephemeral-raw`, `extractionPipelineWorkflow`
        // (src/workflows/extraction-pipeline.ts) purges `sources.raw_body` via
        // `purgeRawBodyActivity` once its extraction_run has landed and this
        // `purge_raw_after` has passed. Capture only writes the hand-off marker;
        // there is no standalone purge job here.

        return {
          captureSessionId: input.captureSessionId,
          sourceId: sourceId as SourceId,
          bodyRetained: built.bodyRetained,
          transcriptChars: built.transcriptChars,
        };
      },
    );
  }

  return { scheduleCaptureBotActivity, pollCaptureBotActivity, storeTranscriptSourceActivity };
}

export type CaptureSessionActivities = ReturnType<typeof createCaptureSessionActivities>;
