import type { EngagementId, TenantId, UserId } from '@fde/core';

import type { EngagementRole, TenantRole } from './schema.js';
import type {
  CheckRequest,
  LookupResourcesRequest,
  RelationshipFilter,
  RelationshipUpdate,
} from './types.js';

/**
 * The swappable authorization seam. SpiceDB backs it in every real deployment
 * (`SpiceDbAuthzClient`); `InMemoryAuthzClient` backs unit tests and local dev.
 * OpenFGA — the ROADMAP's kept alternative — would be a third subclass; the
 * five primitives below are the whole surface it would need to implement.
 *
 * Subclasses implement the five abstract primitives. The typed helpers on top
 * (`canViewEngagement`, `grantEngagementRole`, …) are the API the rest of the
 * platform actually calls — they encode this repo's object types and relation
 * names in one place so callers never hand-build a `ResourceRef`.
 */
export abstract class AuthzClient {
  /** Does `subject` have `permission` on `resource`? Defaults to `minimize_latency`. */
  abstract check(req: CheckRequest): Promise<boolean>;

  /** Apply relationship mutations (CREATE / TOUCH / DELETE) in one transaction. */
  abstract writeRelationships(updates: RelationshipUpdate[]): Promise<void>;

  /** Delete every relationship matching `filter`. */
  abstract deleteRelationships(filter: RelationshipFilter): Promise<void>;

  /** IDs of every `resourceType` object on which `subject` has `permission`. */
  abstract lookupResources(req: LookupResourcesRequest): Promise<string[]>;

  /** Replace the stored schema. Transactional in SpiceDB; see README on consistency. */
  abstract writeSchema(schema: string): Promise<void>;

  // ---- typed helpers -------------------------------------------------------

  canViewEngagement(userId: UserId, engagementId: EngagementId): Promise<boolean> {
    return this.check({
      subject: subj(userId),
      permission: 'view',
      resource: { type: 'engagement', id: engagementId },
    });
  }

  canContributeToEngagement(userId: UserId, engagementId: EngagementId): Promise<boolean> {
    return this.check({
      subject: subj(userId),
      permission: 'contribute',
      resource: { type: 'engagement', id: engagementId },
    });
  }

  canAdministerEngagement(userId: UserId, engagementId: EngagementId): Promise<boolean> {
    return this.check({
      subject: subj(userId),
      permission: 'administer',
      resource: { type: 'engagement', id: engagementId },
    });
  }

  canAdministerTenant(userId: UserId, tenantId: TenantId): Promise<boolean> {
    return this.check({
      subject: subj(userId),
      permission: 'administer',
      resource: { type: 'tenant', id: tenantId },
    });
  }

  /** Engagement IDs the user can `view` — direct role or via a tenant-admin grant. */
  async listViewableEngagements(userId: UserId): Promise<EngagementId[]> {
    const ids = await this.lookupResources({
      subject: subj(userId),
      permission: 'view',
      resourceType: 'engagement',
    });
    return ids as EngagementId[];
  }

  grantEngagementRole(
    userId: UserId,
    engagementId: EngagementId,
    role: EngagementRole,
  ): Promise<void> {
    return this.writeRelationships([
      {
        operation: 'TOUCH',
        resource: { type: 'engagement', id: engagementId },
        relation: role,
        subject: subj(userId),
      },
    ]);
  }

  /** Remove every engagement role (`viewer` / `member` / `admin`) this user holds on the engagement. */
  revokeEngagementRoles(userId: UserId, engagementId: EngagementId): Promise<void> {
    return this.deleteRelationships({
      resourceType: 'engagement',
      resourceId: engagementId,
      subject: { type: 'user', id: userId },
    });
  }

  grantTenantRole(userId: UserId, tenantId: TenantId, role: TenantRole): Promise<void> {
    return this.writeRelationships([
      {
        operation: 'TOUCH',
        resource: { type: 'tenant', id: tenantId },
        relation: role,
        subject: subj(userId),
      },
    ]);
  }

  revokeTenantRoles(userId: UserId, tenantId: TenantId): Promise<void> {
    return this.deleteRelationships({
      resourceType: 'tenant',
      resourceId: tenantId,
      subject: { type: 'user', id: userId },
    });
  }

  /** Parent an engagement to its tenant so tenant admins inherit `view`. Idempotent. */
  linkEngagementToTenant(engagementId: EngagementId, tenantId: TenantId): Promise<void> {
    return this.writeRelationships([
      {
        operation: 'TOUCH',
        resource: { type: 'engagement', id: engagementId },
        relation: 'parent_tenant',
        subject: { type: 'tenant', id: tenantId },
      },
    ]);
  }
}

function subj(userId: string): { type: string; id: string } {
  return { type: 'user', id: userId };
}
