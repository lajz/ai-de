import {
  DecryptCommand,
  EncryptCommand,
  GenerateDataKeyCommand,
  KMSClient,
} from '@aws-sdk/client-kms';

import {
  dekWrapContext,
  type EngagementKeyRef,
  type GeneratedDek,
  type KeyProvider,
} from './key-provider.js';

export interface KmsKeyProviderConfig {
  /** supply a pre-configured client (e.g. pointed at LocalStack in tests) */
  client?: KMSClient;
  region?: string;
}

/** Real KMS-backed provider. One `GenerateDataKey` / `Decrypt` call per engagement per request. */
export class KmsKeyProvider implements KeyProvider {
  private readonly kms: KMSClient;

  constructor(config: KmsKeyProviderConfig = {}) {
    this.kms = config.client ?? new KMSClient(config.region ? { region: config.region } : {});
  }

  async generateDek(ref: EngagementKeyRef): Promise<GeneratedDek> {
    const res = await this.kms.send(
      new GenerateDataKeyCommand({
        KeyId: ref.byokKeyArn ?? ref.tenantCmkArn,
        KeySpec: 'AES_256',
        EncryptionContext: dekWrapContext(ref),
      }),
    );
    if (!res.Plaintext || !res.CiphertextBlob) {
      throw new Error('KMS GenerateDataKey returned no key material');
    }
    return { dek: new Uint8Array(res.Plaintext), wrappedDek: new Uint8Array(res.CiphertextBlob) };
  }

  async unwrapDek(ref: EngagementKeyRef, wrappedDek: Uint8Array): Promise<Uint8Array> {
    const res = await this.kms.send(
      new DecryptCommand({
        CiphertextBlob: wrappedDek,
        KeyId: ref.byokKeyArn ?? ref.tenantCmkArn,
        EncryptionContext: dekWrapContext(ref),
      }),
    );
    if (!res.Plaintext) throw new Error('KMS Decrypt returned no plaintext');
    return new Uint8Array(res.Plaintext);
  }

  /**
   * `Decrypt` under `oldRef`'s key, then `Encrypt` (never `GenerateDataKey`) the
   * same plaintext under `newRef`'s key. If the `Encrypt` call fails — wrong
   * ARN, the cross-account grant hasn't propagated yet, wrong region — this
   * throws and returns nothing; the caller must not have already persisted
   * anything derived from a partial result. The `Decrypt` under the *old* key
   * is unaffected by whatever is wrong with the new one, so a bad new key can
   * never corrupt the existing wrap.
   */
  async rewrapDek(
    oldRef: EngagementKeyRef,
    wrappedDek: Uint8Array,
    newRef: EngagementKeyRef,
  ): Promise<Uint8Array> {
    const dek = await this.unwrapDek(oldRef, wrappedDek);
    const res = await this.kms.send(
      new EncryptCommand({
        KeyId: newRef.byokKeyArn ?? newRef.tenantCmkArn,
        Plaintext: dek,
        EncryptionContext: dekWrapContext(newRef),
      }),
    );
    if (!res.CiphertextBlob) throw new Error('KMS Encrypt returned no ciphertext');
    return new Uint8Array(res.CiphertextBlob);
  }
}
