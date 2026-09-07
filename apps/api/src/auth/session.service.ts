import { randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantId, UserId } from '@fde/core';

export interface Session {
  id: string;
  tenantId: TenantId;
  userId: UserId;
  workosUserId: string;
  email: string;
  createdAt: Date;
}

export interface NewSession {
  tenantId: TenantId;
  userId: UserId;
  workosUserId: string;
  email: string;
}

export const SESSION_COOKIE = 'fde_session';

/**
 * In-memory session store. Deliberately simple for the skeleton — a real
 * deployment moves this to Redis (shared across API instances, TTL'd). The
 * contract the rest of the app depends on:
 *
 *  - `create` mints an opaque 256-bit id; the caller sets it as an httpOnly
 *    cookie and/or hands it back as a bearer token.
 *  - `resolve` returns the session for a live id, or `undefined` once it has
 *    been revoked — which is what "treat the session as revoked" means when a
 *    WorkOS SCIM `dsync.user.deleted` arrives (see `DirectorySyncService`).
 */
@Injectable()
export class SessionService {
  private readonly sessions = new Map<string, Session>();

  create(input: NewSession): Session {
    const session: Session = {
      id: randomBytes(32).toString('base64url'),
      createdAt: new Date(),
      ...input,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  resolve(id: string | undefined): Session | undefined {
    if (!id) return undefined;
    return this.sessions.get(id);
  }

  /** Immediately invalidates every session for a WorkOS user. Returns the count. */
  revokeByWorkosUser(workosUserId: string): number {
    let revoked = 0;
    for (const [id, session] of this.sessions) {
      if (session.workosUserId === workosUserId) {
        this.sessions.delete(id);
        revoked += 1;
      }
    }
    return revoked;
  }

  /** Pulls the session id from `Authorization: Bearer` or the `fde_session` cookie. */
  idFromRequest(req: Request): string | undefined {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim() || undefined;

    const cookie = req.headers.cookie;
    if (!cookie) return undefined;
    for (const pair of cookie.split(';')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      if (pair.slice(0, eq).trim() === SESSION_COOKIE) {
        return decodeURIComponent(pair.slice(eq + 1).trim()) || undefined;
      }
    }
    return undefined;
  }
}
