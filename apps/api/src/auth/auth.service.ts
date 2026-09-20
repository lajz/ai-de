import {
  Inject,
  Injectable,
  Logger,
  type OnModuleInit,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthzClient, type TenantRole } from '@fde/authz';
import type { TenantId, UserId } from '@fde/core';
import { type Database, ensureDevTenant } from '@fde/db';

import type { Env } from '../config/env.js';
import { DB } from '../db/db.module.js';
import { FakeWorkOsService } from './fake-workos.service.js';
import { OrgTenantMap } from './org-tenant-map.js';
import { type Session, SessionService } from './session.service.js';
import { UsersService } from './users.service.js';
import { WORKOS, type WorkOsPort, type WorkOsUser } from './workos.types.js';

const DEV_WORKOS_USER: WorkOsUser = {
  id: 'dev-user',
  email: 'dev@localhost',
  firstName: 'Dev',
  lastName: 'User',
};

@Injectable()
export class AuthService implements OnModuleInit {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(WORKOS) private readonly workos: WorkOsPort,
    @Inject(OrgTenantMap) private readonly orgTenantMap: OrgTenantMap,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AuthzClient) private readonly authz: AuthzClient,
    @Inject(DB) private readonly db: Database,
    @Inject(ConfigService) private readonly config: ConfigService<Env, true>,
  ) {}

  /**
   * Dev/local convenience: re-seed `DEV_SESSION_TOKEN` (if set) as a valid
   * session on every boot, so a `tsx watch` restart — which wipes the rest of
   * `SessionService`'s in-memory store — doesn't force a re-login. No-op
   * without `devLoginEnabled()` (never in production) or without the env var
   * set at all (opt-in, same as the existing `apps/web` fallback that reads
   * it — see `apps/web/src/lib/session.ts`).
   */
  async onModuleInit(): Promise<void> {
    const token = this.config.get('DEV_SESSION_TOKEN', { infer: true });
    if (!token || !this.devLoginEnabled()) return;
    try {
      const { tenantId, userId } = await this.provisionDevUser();
      this.sessions.createWithFixedToken(token, {
        tenantId,
        userId,
        workosUserId: DEV_WORKOS_USER.id,
        email: DEV_WORKOS_USER.email,
      });
      this.logger.log('DEV_SESSION_TOKEN seeded — dev sessions survive api restarts');
    } catch (err) {
      // Best-effort: a DB hiccup on boot shouldn't crash the app over a dev
      // convenience. /auth/dev-login remains available as the manual fallback.
      // `.message` only, not `.stack` — a Postgres connection error's message
      // can embed the connection string, and this always lands in plain boot
      // logs. `.message` alone still distinguishes a real bug from a
      // transient hiccup (a `TypeError`/schema-mismatch message reads
      // nothing like a connection failure's).
      const error = err instanceof Error ? err : new Error(String(err));
      this.logger.warn(`could not seed DEV_SESSION_TOKEN: ${error.message}`);
    }
  }

  /** URL to send the browser to for AuthKit / SAML login. */
  loginUrl(state?: string): string {
    return this.workos.authorizationUrl(state);
  }

  /**
   * Three independent gates, all required: `NODE_ENV === 'development'` —
   * checked directly, not inferred from the other two, so a `test` or any
   * other non-production environment that forgot `WORKOS_API_KEY` doesn't
   * get an admin-granting login bypass for free; the `WORKOS` provider must
   * be the in-memory fake (redundant with the `NODE_ENV` check today, since
   * `WorkOsModule` only falls back to it outside production, but kept as a
   * second independent check rather than relying on one); and
   * `ENABLE_DEV_LOGIN=true` must be set explicitly, so this is something a
   * worktree turns on, not something it gets from an incomplete `.env`.
   * Gates `completeDevLogin` / `AuthController#login`'s dev bypass.
   */
  devLoginEnabled(): boolean {
    return (
      this.config.get('NODE_ENV', { infer: true }) === 'development' &&
      this.workos instanceof FakeWorkOsService &&
      this.config.get('ENABLE_DEV_LOGIN', { infer: true }) === 'true'
    );
  }

  /**
   * Callback handler: exchange the code, map the WorkOS org to a tenant, upsert
   * the `users` row, and mint a session. A WorkOS org with no tenant mapping is
   * a 401 — the user authenticated, but not into anything this platform serves.
   */
  async completeLogin(code: string): Promise<Session> {
    const result = await this.workos.authenticateWithCode(code);
    const tenantId = this.orgTenantMap.resolve(result.organizationId);
    if (!tenantId) {
      throw new UnauthorizedException('WorkOS organization is not provisioned as a tenant');
    }
    const userId = await this.provisionUser(tenantId, result.user, 'member');
    return this.sessions.create({
      tenantId,
      userId,
      workosUserId: result.user.id,
      email: result.user.email,
    });
  }

  /**
   * Dev-only stand-in for `completeLogin` — no real WorkOS account, no
   * `fake-workos.local` redirect (unreachable: it's a placeholder host with no
   * server behind it, see `FakeWorkOsService`). Finds-or-creates a fixed local
   * tenant and mints a session for a fixed dev user directly, granted `admin`
   * (unlike a real SSO login's `member` — there's exactly one local dev
   * account and no one else to protect it from, and without `admin` it
   * couldn't reach `/admin` connector config at all). Only reachable when
   * `devLoginEnabled()` — the caller (`AuthController#login`) checks that.
   */
  async completeDevLogin(): Promise<Session> {
    const { tenantId, userId } = await this.provisionDevUser();
    return this.sessions.create({
      tenantId,
      userId,
      workosUserId: DEV_WORKOS_USER.id,
      email: DEV_WORKOS_USER.email,
    });
  }

  /** `ensureDevTenant` + upsert + `admin` grant — shared by `completeDevLogin` and `onModuleInit`. */
  private async provisionDevUser(): Promise<{ tenantId: TenantId; userId: UserId }> {
    const tenantId = await ensureDevTenant(this.db);
    const userId = await this.provisionUser(tenantId, DEV_WORKOS_USER, 'admin');
    return { tenantId, userId };
  }

  /** Upsert the `users` row and best-effort grant `role`. Shared by every login path. */
  private async provisionUser(
    tenantId: TenantId,
    workosUser: WorkOsUser,
    role: TenantRole,
  ): Promise<UserId> {
    const userId = await this.users.upsertFromSso(tenantId, workosUser);

    // Relationship-seeding seam: record tenant membership on every SSO login so
    // tenant-scoped grants have a subject to attach to. Best-effort — a SpiceDB
    // blip must not block login (the read path still fails closed). M5 seeds
    // per-source ACLs here too.
    try {
      await this.authz.grantTenantRole(userId, tenantId, role);
    } catch {
      // Best-effort: the read path fails closed on its own, so a SpiceDB blip
      // here must not block login. Details surface on the failing check, not here.
      this.logger.warn('authz: could not seed tenant membership on login');
    }
    return userId;
  }
}
