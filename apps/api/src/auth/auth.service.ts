import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';

import { OrgTenantMap } from './org-tenant-map.js';
import { type Session, SessionService } from './session.service.js';
import { UsersService } from './users.service.js';
import { WORKOS, type WorkOsPort } from './workos.types.js';

@Injectable()
export class AuthService {
  constructor(
    @Inject(WORKOS) private readonly workos: WorkOsPort,
    @Inject(OrgTenantMap) private readonly orgTenantMap: OrgTenantMap,
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  /** URL to send the browser to for AuthKit / SAML login. */
  loginUrl(state?: string): string {
    return this.workos.authorizationUrl(state);
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
    const userId = await this.users.upsertFromSso(tenantId, result.user);
    return this.sessions.create({
      tenantId,
      userId,
      workosUserId: result.user.id,
      email: result.user.email,
    });
  }
}
