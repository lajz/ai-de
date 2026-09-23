import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { ApiKeyService } from '../auth/api-key.service.js';
import { type Session, SessionService } from '../auth/session.service.js';
import { IS_PUBLIC } from './metadata.js';

/** What every downstream reader of `req.fdeSession` actually needs — a session carries more, an API key exactly this. */
export type AuthedIdentity = Pick<Session, 'tenantId' | 'userId'>;

export type AuthedRequest = Request & { fdeSession?: AuthedIdentity };

const API_KEY_HEADER = 'x-api-key';

/**
 * Step 1 of the request-context seam. Runs before any interceptor, so an
 * unauthenticated request is rejected with 401 **before a database connection is
 * ever opened**. `@Public()` routes skip through. On success it stashes the
 * resolved identity on the request for `TenantContextInterceptor` to pick up.
 *
 * Two credential kinds resolve to the same `{tenantId, userId}` shape: the
 * WorkOS-SSO-backed session (cookie/bearer token, `SessionService`, no DB
 * work) — for the question view's own browser session — and an `x-api-key`
 * header (`ApiKeyService`, one bare `api_keys` lookup — no `withTenant` yet,
 * since the tenant isn't known until this resolves) for an external MCP
 * caller. Neither path is preferred over the other structurally; a request
 * carrying both uses the session.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(ApiKeyService) private readonly apiKeys: ApiKeyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();

    const session = this.sessions.resolve(this.sessions.tokenFromRequest(req));
    if (session) {
      req.fdeSession = session;
      return true;
    }

    const apiKeyHeader = req.headers[API_KEY_HEADER];
    const apiKey = typeof apiKeyHeader === 'string' ? apiKeyHeader : undefined;
    const identity = await this.apiKeys.resolve(apiKey);
    if (identity) {
      req.fdeSession = identity;
      return true;
    }

    // covers no credential, an unknown/revoked session token, and an
    // unknown/revoked api key.
    throw new UnauthorizedException('authentication required');
  }
}
