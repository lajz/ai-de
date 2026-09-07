import { AsyncLocalStorage } from 'node:async_hooks';

import type { EngagementId, TenantId, UserId } from '@fde/core';
import type { EngagementCipher } from '@fde/crypto';
import type { DbTransaction } from '@fde/db';

/**
 * Everything a request handler is allowed to reach for. Populated once per
 * request by `TenantContextInterceptor`, after the tenant transaction (and, for
 * engagement-scoped routes, the engagement crypto context) is open. Handlers
 * read it with `getRequestContext()` / `getTx()` / `getEngagementContext()` and
 * never call `createDbClient` / `withTenant` / `withEngagement` themselves.
 */
export interface RequestContext {
  tenantId: TenantId;
  userId: UserId;
  /** the open, RLS-scoped transaction for this request */
  tx: DbTransaction;
  /** present only on engagement-scoped routes (see `@EngagementScope()`) */
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

/** The current request context. Throws if the route is not behind the interceptor. */
export function getRequestContext(): RequestContext {
  const ctx = als.getStore();
  if (!ctx) {
    throw new Error(
      'no request context — the route is not behind TenantContextGuard + TenantContextInterceptor',
    );
  }
  return ctx;
}

/** The open, tenant-scoped transaction for the current request. */
export function getTx(): DbTransaction {
  return getRequestContext().tx;
}

/** The engagement id + cipher for the current request. Throws off an engagement-scoped route. */
export function getEngagementContext(): NonNullable<RequestContext['engagement']> {
  const { engagement } = getRequestContext();
  if (!engagement) {
    throw new Error('route is not engagement-scoped — add @EngagementScope() to the handler');
  }
  return engagement;
}

export function tryGetRequestContext(): RequestContext | undefined {
  return als.getStore();
}
