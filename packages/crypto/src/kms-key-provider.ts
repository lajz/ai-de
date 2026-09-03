import { DecryptCommand, GenerateDataKeyCommand, KMSClient } from '@aws-sdk/client-kms';

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
}
