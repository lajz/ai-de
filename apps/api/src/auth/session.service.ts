import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

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
 * The store is keyed by `sha256(token)`, not the token itself: a memory dump
 * then reveals only a hash — same reasoning as never storing raw passwords.
 * `resolve` compares that hash against every stored key with `timingSafeEqual`
 * and no early exit, so lookup latency does not depend on the token's bytes or
 * on whether it matches. Tokens are 256-bit random, so guessing is infeasible
 * regardless — this just removes the side channel entirely.
 */
@Injectable()
export class SessionService {
  /** keyed by `sha256(token)` (hex); looked up in constant time by `resolve` */
  private readonly byTokenHash = new Map<string, Session>();

  private static hash(token: string): Buffer {
    return createHash('sha256').update(token).digest();
  }

  create(input: NewSession): Session {
    const session: Session = {
      token: randomBytes(32).toString('base64url'),
      createdAt: new Date(),
      ...input,
    };
    this.byTokenHash.set(SessionService.hash(session.token).toString('hex'), session);
    return session;
  }

  resolve(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    const target = SessionService.hash(token);
    let match: Session | undefined;
    for (const [key, session] of this.byTokenHash) {
      // Non-short-circuiting: keep scanning every entry even after a hit.
      if (timingSafeEqual(Buffer.from(key, 'hex'), target)) match = session;
    }
    return match;
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
