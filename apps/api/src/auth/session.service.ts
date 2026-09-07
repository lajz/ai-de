import { createHash, randomBytes } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { Request } from 'express';
import type { TenantId, UserId } from '@fde/core';

export interface Session {
  /** the opaque bearer token — the cookie value; never used as the store key */
  token: string;
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
 * deployment moves this to Redis (shared across API instances, TTL'd).
 *
 * The store is keyed by `sha256(token)`, not the token itself: a timing leak on
 * the `Map` key comparison, or a memory dump, then reveals only a hash — same
 * reasoning as never storing raw passwords. Tokens are 256-bit random, so
 * guessing is infeasible regardless.
 */
@Injectable()
export class SessionService {
  private readonly byTokenHash = new Map<string, Session>();

  private static hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  create(input: NewSession): Session {
    const session: Session = {
      token: randomBytes(32).toString('base64url'),
      createdAt: new Date(),
      ...input,
    };
    this.byTokenHash.set(SessionService.hash(session.token), session);
    return session;
  }

  resolve(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    return this.byTokenHash.get(SessionService.hash(token));
  }

  /** Immediately invalidates every session for a WorkOS user. Returns the count. */
  revokeByWorkosUser(workosUserId: string): number {
    let revoked = 0;
    for (const [key, session] of this.byTokenHash) {
      if (session.workosUserId === workosUserId) {
        this.byTokenHash.delete(key);
        revoked += 1;
      }
    }
    return revoked;
  }

  /** Pulls the session token from `Authorization: Bearer` or the `fde_session` cookie. */
  tokenFromRequest(req: Request): string | undefined {
    const auth = req.headers.authorization;
    if (auth?.startsWith('Bearer ')) return auth.slice('Bearer '.length).trim() || undefined;
    return readCookie(req, SESSION_COOKIE);
  }
}

/** Minimal `Cookie:` header parser — avoids a cookie-parser dependency. */
export function readCookie(req: Request, name: string): string | undefined {
  const cookie = req.headers.cookie;
  if (!cookie) return undefined;
  for (const pair of cookie.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    if (pair.slice(0, eq).trim() === name) {
      return decodeURIComponent(pair.slice(eq + 1).trim()) || undefined;
    }
  }
  return undefined;
}
