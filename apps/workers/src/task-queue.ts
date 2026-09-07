import type { TenantId } from '@fde/core';

/**
 * Task-queue naming convention.
 *
 * T0 (pooled): one shared Temporal namespace, **per-tenant task queues** —
 * `taskQueueFor(tenantId)` — so a `Worker` can be scaled or drained per tenant
 * without affecting others, and a noisy tenant can't starve another's
 * workflows of worker slots.
 *
 * T1 (dedicated): the tenant gets its own Temporal namespace entirely, so a
 * single fixed queue name is enough — `DEFAULT_TASK_QUEUE` covers that case
 * (and any workflow not yet tenant-scoped, e.g. this package's `pingWorkflow`
 * smoke test).
 */
const TASK_QUEUE_PREFIX = 'fde';

export const DEFAULT_TASK_QUEUE = `${TASK_QUEUE_PREFIX}-default`;

export function taskQueueFor(tenantId: TenantId): string {
  return `${TASK_QUEUE_PREFIX}-${tenantId}`;
}
