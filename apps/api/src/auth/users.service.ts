import { Inject, Injectable } from '@nestjs/common';
import type { TenantId, UserId } from '@fde/core';
import { type Database, users, withTenant } from '@fde/db';
import { and, eq } from 'drizzle-orm';

import { DB } from '../db/db.module.js';
import type { WorkOsUser } from './workos.types.js';

function fullName(u: WorkOsUser): string | null {
  const parts = [u.firstName, u.lastName].filter((p): p is string => !!p && p.length > 0);
  return parts.length ? parts.join(' ') : null;
}

/**
 * The WorkOS-user ↔ `users`-row bridge. Login/callback/webhook are `@Public`
 * routes with no request transaction, so — unlike a normal handler — these
 * methods open their own `withTenant`. Every write is still RLS-scoped to the
 * resolved tenant.
 */
@Injectable()
export class UsersService {
  constructor(@Inject(DB) private readonly db: Database) {}

  /**
   * Upsert on SSO login. WorkOS always supplies a stable user id, so the
   * identity key is `workos_user_id` — matched first (covers an email change in
   * the IdP). Falling through, `INSERT … ON CONFLICT (tenant_id, email)` handles
   * the first-login and email-collision cases in one statement, with no
   * check-then-insert race between two concurrent first logins.
   */
  async upsertFromSso(tenantId: TenantId, workosUser: WorkOsUser): Promise<UserId> {
    const name = fullName(workosUser);
    if (!workosUser.id) throw new Error('WorkOS user has no id');

    return withTenant(this.db, tenantId, async (tx) => {
      const byWorkosId = await tx
        .update(users)
        .set({ email: workosUser.email, name, status: 'active', updatedAt: new Date() })
        .where(and(eq(users.tenantId, tenantId), eq(users.workosUserId, workosUser.id)))
        .returning({ id: users.id });
      if (byWorkosId[0]) return byWorkosId[0].id as UserId;

      const upserted = await tx
        .insert(users)
        .values({
          tenantId,
          email: workosUser.email,
          name,
          workosUserId: workosUser.id,
          status: 'active',
        })
        .onConflictDoUpdate({
          target: [users.tenantId, users.email],
          set: { name, workosUserId: workosUser.id, status: 'active', updatedAt: new Date() },
        })
        .returning({ id: users.id });
      return upserted[0]!.id as UserId;
    });
  }

  /** SCIM deprovision: disable the user. Returns rows affected (0 if unknown). */
  async deprovision(tenantId: TenantId, workosUserId: string): Promise<number> {
    return withTenant(this.db, tenantId, async (tx) => {
      const updated = await tx
        .update(users)
        .set({ status: 'disabled', updatedAt: new Date() })
        .where(and(eq(users.tenantId, tenantId), eq(users.workosUserId, workosUserId)))
        .returning({ id: users.id });
      return updated.length;
    });
  }
}
