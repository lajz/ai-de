import type { EngagementId, TenantId } from '@fde/core';

/** Identifies the KMS key that wraps an engagement's data-encryption key (DEK). */
export interface EngagementKeyRef {
  tenantId: TenantId;
  engagementId: EngagementId;
  /** the tenant's KMS CMK ARN — root of the DEK tree */
  tenantCmkArn: string;
  /** customer-managed key ARN when BYOK/CMEK is in effect; wraps the DEK instead */
  byokKeyArn?: string;
}

export interface GeneratedDek {
  /** 32-byte AES key — never persisted; held only for the current request */
  dek: Uint8Array;
  /** the DEK encrypted under the CMK — persist as `engagements.wrapped_dek` */
  wrappedDek: Uint8Array;
}

/**
 * Wraps/unwraps a per-engagement DEK under a KMS CMK. The DEK itself does the
 * field encryption (see `EngagementCipher`); this interface is the only thing
 * that talks to KMS.
 */
export interface KeyProvider {
  /** Provision a fresh DEK for a new engagement. */
  generateDek(ref: EngagementKeyRef): Promise<GeneratedDek>;
  /** Recover an existing engagement's DEK from its wrapped form. */
  unwrapDek(ref: EngagementKeyRef, wrappedDek: Uint8Array): Promise<Uint8Array>;
}

/** Encryption context bound into the KMS wrap, so a wrapped DEK can't be relocated. */
export function dekWrapContext(ref: EngagementKeyRef): Record<string, string> {
  return {
    tenantId: ref.tenantId,
    engagementId: ref.engagementId,
    purpose: 'engagement-dek',
  };
}
