import { foreignKey, index, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { CAPTURE_SESSION_STATUSES } from '@fde/core';

import { createdAt, enumFrom, pk, tenantIsolation, updatedAt } from '../columns/_helpers.js';
import { sources } from './sources.js';
import { engagements, retentionPolicyEnum, tenants } from './tenancy.js';

export const captureSessionStatusEnum = enumFrom(
  'capture_session_status',
  CAPTURE_SESSION_STATUSES,
);

/**
 * One meeting-capture attempt: a Recall.ai bot scheduled against a meeting URL,
 * tracked from `scheduled` through to the `sources` row its transcript lands in.
 *
 * The `CaptureSession` Temporal workflow (`@fde/workers`) is the only writer.
 * The workflow payload carries ids + the meeting URL + `joinAt` only — never the
 * transcript body; that arrives via `getTranscript` inside an activity and is
 * field-encrypted into `sources.raw_body` before it touches Postgres.
 *
 * `meeting_url` is stored cleartext, by the same rationale as
 * `sources.url_permalink` / `sources.container_ref`: it is an operational
 * locator (needed to debug or re-schedule a capture), not artifact content. A
 * meeting URL with an embedded passcode is the one edge case; capture bots are
 * scheduled from trusted operator input, and the URL is already in the
 * (encrypted-at-rest) Temporal history regardless.
 */
export const captureSessions = pgTable(
  'capture_sessions',
  {
    id: pk(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'restrict' }),
    engagementId: uuid('engagement_id')
      .notNull()
      .references(() => engagements.id, { onDelete: 'cascade' }),
    /** Recall.ai bot id — null between row creation and the schedule call succeeding */
    botId: text('bot_id'),
    meetingUrl: text('meeting_url').notNull(),
    /** when the bot is asked to join — cleartext, an operational timestamp */
    joinAt: timestamp('join_at', { withTimezone: true }).notNull(),
    status: captureSessionStatusEnum('status').notNull().default('scheduled'),
    /** the transcript `sources` row, set once `storeTranscriptSource` completes */
    sourceId: uuid('source_id'),
    /**
     * `derived-ephemeral-raw`: the wall-clock after which the encrypted
     * `sources.raw_body` should be purged (extraction + a reprocessing window).
     * The purge itself is `ExtractionPipeline`'s job (roadmap #8); this column is
     * the hand-off marker.
     */
    purgeRawAfter: timestamp('purge_raw_after', { withTimezone: true }),
    /** captured from the bot's terminal `fatal` status change, for operators */
    failureReason: text('failure_reason'),
    /** the engagement retention policy in force when this capture ran */
    retentionPolicy: retentionPolicyEnum('retention_policy').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    tenantIsolation('capture_sessions', t.tenantId),
    index('capture_sessions_engagement_idx').on(t.engagementId),
    // one capture session per Recall bot — makes the schedule activity's
    // "did a previous attempt already create the bot?" check a unique lookup.
    unique('capture_sessions_bot_id_uq').on(t.botId),
    // the transcript source must live in the same engagement as this session.
    // NO ACTION (source_id is nullable but engagement_id is part of the key and
    // NOT NULL; a source only dies with its engagement, which drops this row too).
    foreignKey({
      name: 'capture_sessions_source_fk',
      columns: [t.engagementId, t.sourceId],
      foreignColumns: [sources.engagementId, sources.id],
    }),
  ],
);
