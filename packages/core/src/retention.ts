import { z } from 'zod';

export const RETENTION_POLICIES = [
  'reference-only', // no body storage; fetched at query time via the user's own credential
  'derived-ephemeral-raw', // raw kept only for the extraction pass + a short reprocessing window
  'full-retention', // raw stored (encrypted) for the engagement's retention period
] as const;
export const retentionPolicySchema = z.enum(RETENTION_POLICIES);
export type RetentionPolicy = (typeof RETENTION_POLICIES)[number];

/** Whether a policy permits persisting the raw artifact body at all. */
export function storesRawBody(policy: RetentionPolicy): boolean {
  return policy !== 'reference-only';
}

/**
 * Connectors pinned to a policy regardless of the engagement setting. Slack's API
 * terms forbid a durable index/archive, so Slack is always `reference-only`.
 */
export const FORCED_RETENTION_BY_CONNECTOR: Readonly<Record<string, RetentionPolicy>> = {
  slack: 'reference-only',
};

/** Default policy for a newly created engagement, by declared sensitivity. */
export const DEFAULT_RETENTION_BY_SENSITIVITY = {
  regulated: 'derived-ephemeral-raw',
  standard: 'full-retention',
} as const satisfies Record<string, RetentionPolicy>;

/** The policy that actually applies for a connector within an engagement. */
export function effectiveRetention(
  connector: string,
  engagementPolicy: RetentionPolicy,
): RetentionPolicy {
  return FORCED_RETENTION_BY_CONNECTOR[connector] ?? engagementPolicy;
}
