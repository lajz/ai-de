import {
  buildClient,
  CommitmentPolicy,
  RawAesKeyringNode,
  RawAesWrappingSuiteIdentifier,
} from '@aws-crypto/client-node';

import type { Ciphertext, EngagementId, TenantId } from '@fde/core';

import { DecryptContextMismatchError } from './errors.js';

const { encrypt, decrypt } = buildClient(CommitmentPolicy.REQUIRE_ENCRYPT_REQUIRE_DECRYPT);

const KEY_NAMESPACE = 'fde';
const KEY_NAME = 'engagement-dek';

/**
 * Field encryption scoped to one engagement, over the AWS Encryption SDK with a
 * raw-AES keyring keyed by the engagement's DEK. Every value carries an
 * encryption context of `{ tenantId, engagementId, column }`, which is verified
 * on decrypt — a blob moved to another column, engagement, or tenant fails to
 * open. It does NOT bind to a row: swapping two ciphertexts within the same
 * engagement+column is not detected here (that is the DB's integrity concern).
 *
 * Build one per request via `createEngagementCipher`; never cache it across
 * requests (request-scoped crypto-shred guarantee).
 */
export class EngagementCipher {
  private readonly keyring: RawAesKeyringNode;

  constructor(
    readonly tenantId: TenantId,
    readonly engagementId: EngagementId,
    dek: Uint8Array,
  ) {
    this.keyring = new RawAesKeyringNode({
      keyName: KEY_NAME,
      keyNamespace: KEY_NAMESPACE,
      unencryptedMasterKey: dek,
      wrappingSuite: RawAesWrappingSuiteIdentifier.AES256_GCM_IV12_TAG16_NO_PADDING,
    });
  }

  private context(columnPath: string): Record<string, string> {
    return { tenantId: this.tenantId, engagementId: this.engagementId, column: columnPath };
  }

  async encryptString(columnPath: string, plaintext: string): Promise<Ciphertext> {
    const { result } = await encrypt(this.keyring, plaintext, {
      encryptionContext: this.context(columnPath),
    });
    return new Uint8Array(result) as Ciphertext;
  }

  async decryptString(columnPath: string, ciphertext: Ciphertext): Promise<string> {
    // `RawAesKeyringNode` folds the encryption context into the AES-GCM AAD that
    // protects the wrapped data key, so in practice the SDK's unwrap already
    // fails for a wrong DEK *or* a relocated blob (different tenant/engagement/
    // column) — see the cross-engagement test. The explicit comparison below is
    // defence in depth: a typed error, and independence from that SDK detail.
    const { plaintext, messageHeader } = await decrypt(this.keyring, Buffer.from(ciphertext));
    const expected = this.context(columnPath);
    const actual: Record<string, string | undefined> = messageHeader.encryptionContext;
    for (const [k, v] of Object.entries(expected)) {
      if (actual[k] !== v) throw new DecryptContextMismatchError(expected, actual);
    }
    return plaintext.toString('utf8');
  }

  async encryptJson<T>(columnPath: string, value: T): Promise<Ciphertext> {
    return this.encryptString(columnPath, JSON.stringify(value));
  }

  async decryptJson<T>(columnPath: string, ciphertext: Ciphertext): Promise<T> {
    return JSON.parse(await this.decryptString(columnPath, ciphertext)) as T;
  }
}
