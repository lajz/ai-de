import type { EngagementId, TenantId, UserId } from '@fde/core';
import { getCipher, type KeyProvider } from '@fde/crypto';
import { type Database, withEngagement } from '@fde/db';
import { runWithRequestContext } from '@fde/request-context';

import type { McpLineage, McpRetrieval, McpToolDeps } from './deps.js';

/**
 * Who's calling and which engagement they're scoped to. Bound server-side —
 * for the internal (in-process) transport this is fixed for the life of one
 * question, closed over when `createMcpServer` builds the tool set, and is
 * never a field a tool's input schema exposes to the model.
 */
export interface ToolCallContext {
  tenantId: TenantId;
  userId: UserId;
  engagementId: EngagementId;
}

/**
 * Opens one short-lived `withEngagement` transaction per tool call — not one
 * transaction for the whole agent loop — mirroring `apps/workers`'
 * `withEngagementActivity`: a non-HTTP caller re-enters the same
 * tenant/engagement/authz pipeline `TenantContextInterceptor` runs for an
 * HTTP request, just per unit of work instead of per request. Every
 * downstream call (`RetrievalService.searchContext`, `LineageService.*`)
 * reads this exact context via `getRequestContext()`/`getEngagementContext()`,
 * so the authz gate and RLS scoping run unchanged regardless of caller.
 */
export function withToolContext<T>(
  db: Database,
  keyProvider: KeyProvider,
  ctx: ToolCallContext,
  fn: () => Promise<T>,
): Promise<T> {
  return withEngagement(
    db,
    keyProvider,
    { tenantId: ctx.tenantId, engagementId: ctx.engagementId },
    (tx) =>
      runWithRequestContext(
        {
          tenantId: ctx.tenantId,
          userId: ctx.userId,
          tx,
          engagement: { id: ctx.engagementId, cipher: getCipher() },
        },
        fn,
      ),
  );
}

/** Builds the real, DB-backed `McpToolDeps` — what `apps/api`'s agent-loop wiring uses. */
export function createDbToolDeps(
  db: Database,
  keyProvider: KeyProvider,
  retrieval: McpRetrieval,
  lineage: McpLineage,
): McpToolDeps {
  return {
    retrieval,
    lineage,
    runInContext: (ctx, fn) => withToolContext(db, keyProvider, ctx, fn),
  };
}
