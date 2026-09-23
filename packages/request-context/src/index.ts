import { AsyncLocalStorage } from 'node:async_hooks';

import type { EngagementId, TenantId, UserId } from '@fde/core';
import type { EngagementCipher } from '@fde/crypto';
import type { DbTransaction } from '@fde/db';

/**
 * Everything a request handler is allowed to reach for. In `apps/api`,
 * populated once per HTTP request by `TenantContextInterceptor`, after the
 * tenant transaction (and, for engagement-scoped routes, the engagement
 * crypto context) is open. Handlers read it with `getRequestContext()` /
 * `getTx()` / `getEngagementContext()` and never call `createDbClient` /
 * `withTenant` / `withEngagement` themselves.
 *
 * `apps/mcp`'s tool handlers are the second caller of this module — each
 * tool invocation opens its own short-lived `withEngagement` (mirroring
 * `apps/workers`' `withEngagementActivity`) and runs its work through
 * `runWithRequestContext`, so `RetrievalService`/`LineageService` read the
 * exact same ambient context regardless of which caller populated it.
 */
export interface RequestContext {
  tenantId: TenantId;
  userId: UserId;
  /** the open, RLS-scoped transaction for this unit of work */
  tx: DbTransaction;
  /** present only when scoped to one engagement (see `@EngagementScope()`) */
  engagement?: {
    id: EngagementId;
    cipher: EngagementCipher;
  };
}

const als = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with `ctx` as the ambient request context. */
export function runWithRequestContext<T>(ctx: RequestContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

/** The current request context. Throws if nothing populated it for this async chain. */
export function getRequestContext(): RequestContext {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error(
      'no request context — the caller is not behind TenantContextGuard + TenantContextInterceptor, ' +
        'and did not call runWithRequestContext() itself',
    );
  }
  return ctx;
}

/** The open, tenant-scoped transaction for the current request. */
export function getTx(): DbTransaction {
  return getRequestContext().tx;
}

/** The engagement id + cipher for the current request. Throws when not engagement-scoped. */
export function getEngagementContext(): NonNullable<RequestContext['engagement']> {
  const { engagement } = getRequestContext();
  if (!engagement) {
    throw new Error('not engagement-scoped — pass `engagement` to runWithRequestContext()');
  }
  return engagement;
}

export function tryGetRequestContext(): RequestContext | undefined {
  return als.getStore();
}
