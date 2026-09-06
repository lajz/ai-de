import { z } from 'zod';

/**
 * `shredded` is terminal: the engagement's data-encryption key has been destroyed
 * (BYOK revoke or engagement close), so its encrypted content is permanently
 * unreadable. Rows may still exist as ciphertext pending async purge.
 */
export const ENGAGEMENT_STATUSES = ['active', 'closed', 'shredded'] as const;
export const engagementStatusSchema = z.enum(ENGAGEMENT_STATUSES);
export type EngagementStatus = (typeof ENGAGEMENT_STATUSES)[number];
