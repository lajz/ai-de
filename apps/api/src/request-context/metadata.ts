import { type CustomDecorator, SetMetadata } from '@nestjs/common';

/** Route metadata key: skip auth + the tenant transaction entirely. */
export const IS_PUBLIC = 'fde:isPublic';

/**
 * Marks a route as unauthenticated — `TenantContextGuard` lets it through and
 * `TenantContextInterceptor` opens no transaction. Use for `/healthz`, the SSO
 * login/callback pair, and the WorkOS webhook receiver.
 */
export const Public = (): CustomDecorator => SetMetadata(IS_PUBLIC, true);

/** Route metadata key: the request path parameter holding the engagement id. */
export const ENGAGEMENT_SCOPE = 'fde:engagementScopeParam';

/**
 * Marks a route as engagement-scoped: the interceptor opens `withEngagement`
 * (tenant tx + one KMS DEK unwrap) instead of plain `withTenant`, so the handler
 * can read 🔒 columns via `getEngagementContext().cipher`. `param` is the route
 * parameter name carrying the engagement id (default `id`).
 */
export const EngagementScope = (param = 'id'): CustomDecorator =>
  SetMetadata(ENGAGEMENT_SCOPE, param);

/** Route metadata key: authenticated, but no ambient transaction around the handler. */
export const NO_TRANSACTION_SCOPE = 'fde:noTransactionScope';

/**
 * Marks a route as authenticated-but-untransacted: `TenantContextGuard` still
 * 401s an unauthenticated caller, but `TenantContextInterceptor` opens no
 * `withTenant`/`withEngagement` around the handler — it calls `next.handle()`
 * directly. For a handler whose work can span longer than one request-sized
 * unit (a streaming multi-step agent loop), holding one transaction open for
 * the whole thing risks an idle-in-transaction connection and lock
 * contention with a concurrent crypto-shred. The handler reads
 * `tenantId`/`userId` straight off `req.fdeSession` (the guard already
 * populated it) and, for any actual DB/decrypt work, opens its own
 * short-lived `withEngagement` per unit of work — see `apps/mcp`'s
 * `withToolContext`, the same pattern `apps/workers`' `withEngagementActivity`
 * already uses for a non-HTTP caller. `getRequestContext()` throws inside a
 * route marked this way; that's intentional — it's the signal a handler
 * reached for ambient context it was never given.
 */
export const NoTransactionScope = (): CustomDecorator => SetMetadata(NO_TRANSACTION_SCOPE, true);
