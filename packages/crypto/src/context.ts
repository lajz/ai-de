import { AsyncLocalStorage } from 'node:async_hooks';

import type { EngagementId, TenantId } from '@fde/core';

import type { EngagementCipher } from './engagement-cipher.js';
import { MissingCryptoContextError } from './errors.js';

export interface CryptoContext {
  tenantId: TenantId;
  engagementId: EngagementId;
  cipher: EngagementCipher;
}

const als = new AsyncLocalStorage<CryptoContext>();

/** Establishes the engagement crypto context for the duration of `fn`. */
export function runWithCrypto<T>(ctx: CryptoContext, fn: () => Promise<T>): Promise<T> {
  return als.run(ctx, fn);
}

/** The cipher for the current engagement. Throws `MissingCryptoContextError` if unset. */
export function getCipher(): EngagementCipher {
  const ctx = als.getStore();
  if (!ctx) throw new MissingCryptoContextError();
  return ctx.cipher;
}

export function tryGetCryptoContext(): CryptoContext | undefined {
  return als.getStore();
}
