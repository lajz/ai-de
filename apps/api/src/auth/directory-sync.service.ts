import { Inject, Injectable, Logger } from '@nestjs/common';

import { OrgTenantMap } from './org-tenant-map.js';
import { SessionService } from './session.service.js';
import { UsersService } from './users.service.js';
import type { WorkOsEvent } from './workos.types.js';

/** WorkOS Directory-Sync events that revoke a user's access. */
const DEPROVISION_EVENTS = new Set(['dsync.user.deleted', 'dsync.user.deactivated']);

export interface DirectorySyncOutcome {
  event: string;
  /** what the receiver did — for the webhook 200 body + logs, never content */
  action: 'deprovisioned' | 'ignored';
  usersDisabled?: number;
  sessionsRevoked?: number;
  reason?: string;
}

/**
 * Applies a verified WorkOS Directory-Sync / SCIM event. Only deprovision events
 * are acted on in the skeleton: the mapped user's `users.status` goes to
 * `disabled` and every live session for that WorkOS user is revoked immediately
 * (architecture: "SCIM deprovisioning revokes access, sessions, and tokens
 * immediately").
 */
@Injectable()
export class DirectorySyncService {
  private readonly logger = new Logger(DirectorySyncService.name);

  constructor(
    @Inject(UsersService) private readonly users: UsersService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(OrgTenantMap) private readonly orgTenantMap: OrgTenantMap,
  ) {}

  async apply(event: WorkOsEvent): Promise<DirectorySyncOutcome> {
    if (!DEPROVISION_EVENTS.has(event.event)) {
      return { event: event.event, action: 'ignored', reason: 'not a deprovision event' };
    }

    const data = event.data;
    const workosUserId = typeof data.id === 'string' ? data.id : undefined;
    const organizationId =
      typeof data.organization_id === 'string' ? data.organization_id : undefined;
    const tenantId = this.orgTenantMap.resolve(organizationId);

    if (!workosUserId || !tenantId) {
      const reason = !workosUserId
        ? 'event payload has no user id'
        : `no tenant mapped for WorkOS org ${organizationId ?? '(none)'}`;
      this.logger.warn(`ignoring ${event.event}: ${reason}`);
      return { event: event.event, action: 'ignored', reason };
    }

    const usersDisabled = await this.users.deprovision(tenantId, workosUserId);
    const sessionsRevoked = this.sessions.revokeByWorkosUser(workosUserId);
    this.logger.log(
      `${event.event}: disabled ${usersDisabled} user(s), revoked ${sessionsRevoked} session(s)`,
    );
    return { event: event.event, action: 'deprovisioned', usersDisabled, sessionsRevoked };
  }
}
