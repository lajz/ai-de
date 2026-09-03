import type { EngagementId, TenantId } from '@fde/core';

import { EngagementCipher } from './engagement-cipher.js';
import type { EngagementKeyRef, KeyProvider } from './key-provider.js';

export interface OpenCipherParams {
  tenantId: TenantId;
  engagementId: EngagementId;
  tenantCmkArn: string;
  byokKeyArn?: string;
  /** `engagements.wrapped_dek` */
  wrappedDek: Uint8Array;
}

/**
 * Unwraps the engagement DEK once (one KMS `Decrypt`) and returns a cipher scoped
 * to this engagement. Call once per request / Temporal activity; do not hold the
 * returned cipher across requests.
 */
export async function createEngagementCipher(
  provider: KeyProvider,
  params: OpenCipherParams,
): Promise<EngagementCipher> {
  const ref: EngagementKeyRef = {
    tenantId: params.tenantId,
    engagementId: params.engagementId,
    tenantCmkArn: params.tenantCmkArn,
    byokKeyArn: params.byokKeyArn,
  };
  const dek = await provider.unwrapDek(ref, params.wrappedDek);
  return new EngagementCipher(params.tenantId, params.engagementId, dek);
}
