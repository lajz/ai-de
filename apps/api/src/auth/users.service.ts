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

  /** Upsert on SSO login. Matches on `workos_user_id`, else on `(tenant, email)`. */
  async upsertFromSso(tenantId: TenantId, workosUser: WorkOsUser): Promise<UserId> {
    return withTenant(this.db, tenantId, async (tx) => {
      const existing = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.tenantId, tenantId),
            workosUser.id
              ? eq(users.workosUserId, workosUser.id)
              : eq(users.email, workosUser.email),
          ),
        )
        .limit(1);

      const row = existing[0];
      if (row) {
        await tx
          .update(users)
          .set({
            email: workosUser.email,
            name: fullName(workosUser),
            workosUserId: workosUser.id,
            status: 'active',
            updatedAt: new Date(),
          })
          .where(eq(users.id, row.id));
        return row.id as UserId;
      }

      const inserted = await tx
        .insert(users)
        .values({
          tenantId,
          email: workosUser.email,
          name: fullName(workosUser),
          workosUserId: workosUser.id,
          status: 'active',
        })
        .returning({ id: users.id });
      return inserted[0]!.id as UserId;
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
