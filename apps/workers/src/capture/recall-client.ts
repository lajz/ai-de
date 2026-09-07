/**
 * The seam over Recall.ai (https://docs.recall.ai) — our own meeting capture.
 *
 * Recall's real flow: `POST /api/v1/bot` creates a bot for a meeting URL (with
 * an optional `join_at` for a scheduled join) → the bot dials in → the meeting
 * ends and Recall finishes processing → the transcript JSON is retrievable.
 * `HttpRecallClient` speaks that API; `FakeRecallClient` is a deterministic
 * in-memory stand-in the workflow logic + its tests run against. Swapping the
 * real client in is a config flip (`RECALL_API_KEY` present) — see
 * `loadRecallClient`.
 *
 * Recall's wire shapes (status-change code soup, versioned transcript formats)
 * stay inside `HttpRecallClient`; everything above this interface sees only the
 * normalized types below.
 */

export interface ScheduleBotInput {
  /** the meeting link the bot should join (Zoom / Meet / Teams / …) */
  meetingUrl: string;
  /** ISO-8601 instant the bot should join the call */
  joinAt: string;
  /** display name the bot shows as in the participant list */
  botName?: string;
}

export interface ScheduledBot {
  botId: string;
}

/**
 * Recall's ~20 status-change codes collapsed to the states the workflow
 * actually branches on:
 *
 *  - `scheduled` — bot created, not yet joined
 *  - `joining`   — dialing in / in the waiting room
 *  - `in_call`   — in the meeting (recording or not), or the call ended and
 *                  Recall is still processing the recording
 *  - `done`      — recording + transcription complete; `getTranscript` will return
 *  - `failed`    — a terminal error (removed from call, permission denied, fatal)
 */
export type CaptureBotStatus = 'scheduled' | 'joining' | 'in_call' | 'done' | 'failed';

export interface CaptureBotState {
  botId: string;
  status: CaptureBotStatus;
  /** Recall's terminal status message, when `status === 'failed'` */
  failureReason?: string;
}

export interface TranscriptWord {
  text: string;
  /** seconds from the start of the recording; null if Recall didn't time-align it */
  start: number | null;
  end: number | null;
}

export interface TranscriptSegment {
  /** the diarized speaker's display name, when Recall resolved one */
  speaker: string | null;
  words: TranscriptWord[];
}

export interface RecallClient {
  /** Create + schedule a bot for a meeting. Persist the returned `botId`. */
  scheduleBot(input: ScheduleBotInput): Promise<ScheduledBot>;
  /** Current lifecycle state of a bot — the poll target while waiting for a meeting to finish. */
  getBot(botId: string): Promise<CaptureBotState>;
  /** The finished transcript, normalized to speaker-tagged segments. Call only once `status === 'done'`. */
  getTranscript(botId: string): Promise<TranscriptSegment[]>;
}

/** Raised by `HttpRecallClient` for a non-2xx Recall response. Message is safe to log (no transcript content). */
export class RecallApiError extends Error {
  constructor(
    readonly status: number,
    readonly method: string,
    readonly path: string,
    readonly detail: string,
  ) {
    super(`Recall API ${method} ${path} → ${status}${detail ? `: ${detail}` : ''}`);
    this.name = 'RecallApiError';
  }
}
