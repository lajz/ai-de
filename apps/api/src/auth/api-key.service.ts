import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import type { TenantId, UserId } from '@fde/core';
import { apiKeys, type Database } from '@fde/db';
import { and, eq, isNull } from 'drizzle-orm';

import { DB } from '../db/db.module.js';

export interface ApiKeyIdentity {
  tenantId: TenantId;
  userId: UserId;
}

const RAW_PREFIX = 'fde_';
/** Chars of the raw key stored in cleartext for the indexed lookup bucket — never enough to guess the rest. */
const PREFIX_LEN = RAW_PREFIX.length + 8;

function hash(rawKey: string): Buffer {
  return createHash('sha256').update(rawKey).digest();
}

/** A freshly minted key. `raw` is shown to the issuer exactly once — only `hash`/`prefix` are stored. */
export interface GeneratedApiKey {
  raw: string;
  prefix: string;
  hashHex: string;
}

/** `randomBytes(32)` of entropy, `fde_`-prefixed so a leaked key is greppable. Never logged. */
export function generateApiKey(): GeneratedApiKey {
  const raw = `${RAW_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { raw, prefix: raw.slice(0, PREFIX_LEN), hashHex: hash(raw).toString('hex') };
}

/**
 * Resolves an `x-api-key` header to the same `{tenantId, userId}` shape a
 * session resolves to — a key is just an alternate credential for a
 * service-account `users` row, so every downstream check (`canViewEngagement`,
 * RLS, `filterCandidatesByAcl`) runs completely unchanged.
 *
 * The lookup is a **bare** `api_keys` query — no `withTenant` — because the
 * tenant isn't known yet; that's exactly why the table carries no RLS policy
 * (see `packages/db/src/schema/api-keys.ts`). Unlike `SessionService`'s
 * in-memory, scan-every-row store, this narrows to an indexed `key_prefix`
 * bucket first (`api_keys` is a real, potentially large Postgres table, not a
 * small in-process session map) and only then does the constant-time hash
 * compare, non-short-circuiting across that bucket.
 */
@Injectable()
export class ApiKeyService {
  constructor(@Inject(DB) private readonly db: Database) {}

  async resolve(rawKey: string | undefined): Promise<ApiKeyIdentity | undefined> {
    if (!rawKey || !rawKey.startsWith(RAW_PREFIX)) return undefined;
    const prefix = rawKey.slice(0, PREFIX_LEN);
    const target = hash(rawKey);

    const candidates = await this.db
      .select({
        tenantId: apiKeys.tenantId,
        userId: apiKeys.userId,
        keyHash: apiKeys.keyHash,
      })
      .from(apiKeys)
      .where(and(eq(apiKeys.keyPrefix, prefix), isNull(apiKeys.revokedAt)));

    let match: ApiKeyIdentity | undefined;
    for (const row of candidates) {
      // Non-short-circuiting: keep scanning every candidate in the bucket even after a hit.
      if (timingSafeEqual(Buffer.from(row.keyHash, 'hex'), target)) {
        match = { tenantId: row.tenantId as TenantId, userId: row.userId as UserId };
      }
    }

    if (match) {
      try {
        await this.db
          .update(apiKeys)
          .set({ lastUsedAt: new Date() })
          .where(eq(apiKeys.keyPrefix, prefix));
      } catch {
        // best-effort — never block auth on a failure to record last-used
      }
    }
    return match;
  }
}
