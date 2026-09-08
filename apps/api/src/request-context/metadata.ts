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
