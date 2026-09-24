import { z } from 'zod';

/**
 * `access_log.action` values. `crypto_shred` is written by `shredEngagement`
 * and `byok_key_rotated` by `rotateEngagementKey` (both @fde/db) — keep those
 * strings identical if they ever change here.
 */
export const ACCESS_LOG_ACTIONS = [
  'content_read',
  'retrieval',
  'break_glass_requested',
  'break_glass_approved',
  'break_glass_accessed',
  'break_glass_revoked',
  'crypto_shred',
  'crypto_shred_purge_completed',
  'byok_key_rotated',
  'identity_merge',
] as const;
export const accessLogActionSchema = z.enum(ACCESS_LOG_ACTIONS);
export type AccessLogAction = (typeof ACCESS_LOG_ACTIONS)[number];
