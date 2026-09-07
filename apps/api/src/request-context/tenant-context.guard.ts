import {
  type CanActivate,
  type ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';

import { type Session, SessionService } from '../auth/session.service.js';
import { IS_PUBLIC } from './metadata.js';

export type AuthedRequest = Request & { fdeSession?: Session };

/**
 * Step 1 of the request-context seam. Runs before any interceptor, so an
 * unauthenticated request is rejected with 401 **before a database connection is
 * ever opened**. `@Public()` routes skip through. On success it stashes the
 * resolved `Session` on the request for `TenantContextInterceptor` to pick up —
 * this guard does no DB work itself.
 */
@Injectable()
export class TenantContextGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const session = this.sessions.resolve(this.sessions.idFromRequest(req));
    if (!session) {
      // covers no session, an unknown id, and an id whose session was revoked
      // by a SCIM deprovision (SessionService.revokeByWorkosUser).
      throw new UnauthorizedException('authentication required');
    }
    req.fdeSession = session;
    return true;
  }
}
