import {
  type CallHandler,
  type ExecutionContext,
  GoneException,
  Inject,
  Injectable,
  type NestInterceptor,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { from, lastValueFrom, type Observable } from 'rxjs';
import type { EngagementId, TenantId, UserId } from '@fde/core';
import { EngagementShreddedError, getCipher, type KeyProvider } from '@fde/crypto';
import { type Database, withEngagement, withTenant } from '@fde/db';

import { KEY_PROVIDER } from '../key-provider/key-provider.module.js';
import { DB } from '../db/db.module.js';
import { ENGAGEMENT_SCOPE, IS_PUBLIC } from './metadata.js';
import { runWithRequestContext } from './request-context.js';
import type { AuthedRequest } from './tenant-context.guard.js';

const ENGAGEMENT_NOT_FOUND = /^engagement .* not found$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Step 2 of the request-context seam. For every authenticated route it opens the
 * tenant transaction — `withTenant` — around the handler, and for a route marked
 * `@EngagementScope()` it opens `withEngagement` instead (tenant tx + one KMS
 * DEK unwrap). The tx (and, when present, the engagement cipher) reach the
 * handler through `AsyncLocalStorage` (`runWithRequestContext`), so handlers
 * never call `withTenant` / `withEngagement` / `createDbClient` themselves.
 *
 * `next.handle()` is subscribed *inside* the transaction callback via
 * `lastValueFrom`, so the whole handler — and anything it awaits — runs within
 * the open transaction and commits when it resolves.
 */
@Injectable()
export class TenantContextInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(DB) private readonly db: Database,
    @Inject(KEY_PROVIDER) private readonly keyProvider: KeyProvider,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) {
      return next.handle();
    }

    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const session = req.fdeSession;
    if (!session) return next.handle(); // TenantContextGuard already 401s

    const engParam = this.reflector.getAllAndOverride<string>(ENGAGEMENT_SCOPE, targets);
    const params = req.params as Record<string, string | undefined>;
    const engagementId = engParam ? params[engParam] : undefined;

    return from(
      this.runInContext(session.tenantId, session.userId, engagementId, () =>
        lastValueFrom(next.handle()),
      ),
    );
  }

  private async runInContext(
    tenantId: TenantId,
    userId: UserId,
    engagementId: string | undefined,
    handler: () => Promise<unknown>,
  ): Promise<unknown> {
    // the interceptor runs before route pipes (ParseUUIDPipe), so guard the id
    // shape here — a non-UUID would otherwise blow up the SQL cast as a 500.
    if (engagementId !== undefined && !UUID.test(engagementId)) {
      throw new NotFoundException('engagement not found');
    }

    try {
      if (engagementId) {
        const id = engagementId as EngagementId;
        return await withEngagement(
          this.db,
          this.keyProvider,
          { tenantId, engagementId: id },
          (tx) =>
            runWithRequestContext(
              { tenantId, userId, tx, engagement: { id, cipher: getCipher() } },
              handler,
            ),
        );
      }
      return await withTenant(this.db, tenantId, (tx) =>
        runWithRequestContext({ tenantId, userId, tx }, handler),
      );
    } catch (err) {
      if (err instanceof EngagementShreddedError) {
        throw new GoneException('engagement is crypto-shredded');
      }
      if (err instanceof Error && ENGAGEMENT_NOT_FOUND.test(err.message)) {
        throw new NotFoundException('engagement not found');
      }
      throw err;
    }
  }
}
