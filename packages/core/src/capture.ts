import { z } from 'zod';

/**
 * Lifecycle of a meeting-capture session (`capture_sessions` row, driven by the
 * `CaptureSession` Temporal workflow):
 *
 *  - `scheduled`  — a Recall.ai bot has been created / scheduled for the meeting
 *  - `recording`  — the bot is in the call (reserved for the webhook-signal path)
 *  - `capturing`  — the meeting ended; transcript is being fetched + stored
 *  - `captured`   — the transcript landed in a `sources` row
 *  - `failed`     — the bot hit a terminal error, or the capture timed out
 */
export const CAPTURE_SESSION_STATUSES = [
  'scheduled',
  'recording',
  'capturing',
  'captured',
  'failed',
] as const;
export const captureSessionStatusSchema = z.enum(CAPTURE_SESSION_STATUSES);
export type CaptureSessionStatus = (typeof CAPTURE_SESSION_STATUSES)[number];
