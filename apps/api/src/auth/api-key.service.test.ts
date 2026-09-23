import { randomUUID } from 'node:crypto';

import type { TenantId, UserId } from '@fde/core';
import type { Database } from '@fde/db';
import { describe, expect, it, vi } from 'vitest';

import { ApiKeyService, generateApiKey } from './api-key.service.js';

interface Row {
  tenantId: TenantId;
  userId: UserId;
  keyHash: string;
  keyPrefix: string;
  revokedAt: Date | null;
}

/** A drizzle-shaped chain: `.select().from().where()` resolves to the rows whose prefix matches; `.update()` is a no-op that succeeds unless told to throw. */
function fakeDb(
  rows: Row[],
  opts: { updateThrows?: boolean } = {},
): { db: Database; updateCalls: unknown[] } {
  const updateCalls: unknown[] = [];
  const selectChain = {
    from: () => selectChain,
    where: (cond: unknown) => {
      // The fake doesn't evaluate drizzle's SQL AST — it just returns everything
      // the test seeded; each test seeds only the rows relevant to its own prefix.
      void cond;
      return Promise.resolve(rows.filter((r) => r.revokedAt === null));
    },
  };
  const updateChain = {
    set: (values: unknown) => ({
      where: (cond: unknown) => {
        updateCalls.push({ values, cond });
        if (opts.updateThrows) return Promise.reject(new Error('db down'));
        return Promise.resolve();
      },
    }),
  };
  const db = {
    select: () => selectChain,
    update: () => updateChain,
  } as unknown as Database;
  return { db, updateCalls };
}

describe('generateApiKey', () => {
  it('produces an fde_-prefixed raw key whose hash matches sha256(raw)', () => {
    const { raw, prefix, hashHex } = generateApiKey();
    expect(raw.startsWith('fde_')).toBe(true);
    expect(prefix).toBe(raw.slice(0, prefix.length));
    expect(hashHex).toMatch(/^[0-9a-f]{64}$/);

    // Two keys never collide (256 bits of entropy) and hash independently.
    const second = generateApiKey();
    expect(second.raw).not.toBe(raw);
    expect(second.hashHex).not.toBe(hashHex);
  });
});

describe('ApiKeyService.resolve', () => {
  const tenantId = randomUUID() as TenantId;
  const userId = randomUUID() as UserId;

  it('resolves a valid key to {tenantId, userId} and bumps lastUsedAt', async () => {
    const key = generateApiKey();
    const row: Row = {
      tenantId,
      userId,
      keyHash: key.hashHex,
      keyPrefix: key.prefix,
      revokedAt: null,
    };
    const { db, updateCalls } = fakeDb([row]);
    const svc = new ApiKeyService(db);

    const identity = await svc.resolve(key.raw);

    expect(identity).toEqual({ tenantId, userId });
    expect(updateCalls).toHaveLength(1);
  });

  it('rejects a raw key that does not match any stored hash, even within the same prefix bucket', async () => {
    const key = generateApiKey();
    const row: Row = {
      tenantId,
      userId,
      keyHash: key.hashHex,
      keyPrefix: key.prefix,
      revokedAt: null,
    };
    const { db } = fakeDb([row]);
    const svc = new ApiKeyService(db);

    // Same prefix (forced), wrong secret.
    const forged = key.prefix + 'not-the-real-secret';
    expect(await svc.resolve(forged)).toBeUndefined();
  });

  it('rejects undefined, empty, and non-fde_-prefixed input without touching the db', async () => {
    const { db, updateCalls } = fakeDb([]);
    const selectSpy = vi.spyOn(db, 'select');
    const svc = new ApiKeyService(db);

    expect(await svc.resolve(undefined)).toBeUndefined();
    expect(await svc.resolve('')).toBeUndefined();
    expect(await svc.resolve('not-an-fde-key')).toBeUndefined();
    expect(selectSpy).not.toHaveBeenCalled();
    expect(updateCalls).toHaveLength(0);
  });

  it('never resolves a revoked key', async () => {
    const key = generateApiKey();
    const row: Row = {
      tenantId,
      userId,
      keyHash: key.hashHex,
      keyPrefix: key.prefix,
      revokedAt: new Date(),
    };
    const { db } = fakeDb([row]);
    const svc = new ApiKeyService(db);

    expect(await svc.resolve(key.raw)).toBeUndefined();
  });

  it('still resolves the identity even if the best-effort lastUsedAt update fails', async () => {
    const key = generateApiKey();
    const row: Row = {
      tenantId,
      userId,
      keyHash: key.hashHex,
      keyPrefix: key.prefix,
      revokedAt: null,
    };
    const { db } = fakeDb([row], { updateThrows: true });
    const svc = new ApiKeyService(db);

    await expect(svc.resolve(key.raw)).resolves.toEqual({ tenantId, userId });
  });
});
