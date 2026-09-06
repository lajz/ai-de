import { CreateKeyCommand, KMSClient } from '@aws-sdk/client-kms';
import { describe, expect, it } from 'vitest';

import { KmsKeyProvider } from './index.js';

// Integration test against a real KMS API (LocalStack). Skipped unless
// TEST_KMS_ENDPOINT is set:
//   docker compose --profile aws up -d localstack
//   TEST_KMS_ENDPOINT=http://localhost:4566 pnpm test
const endpoint = process.env.TEST_KMS_ENDPOINT;

describe.skipIf(!endpoint)('KmsKeyProvider (LocalStack)', () => {
  const client = new KMSClient({
    endpoint,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const ids = { tenantId: 't-1' as never, engagementId: 'e-1' as never };

  it('wraps and unwraps a DEK under a CMK, honouring the encryption context', async () => {
    const { KeyMetadata } = await client.send(new CreateKeyCommand({}));
    const tenantCmkArn = KeyMetadata!.Arn!;
    const provider = new KmsKeyProvider({ client });

    const { dek, wrappedDek } = await provider.generateDek({ ...ids, tenantCmkArn });
    expect(dek).toHaveLength(32);
    expect(Buffer.from(wrappedDek).equals(Buffer.from(dek))).toBe(false);

    const unwrapped = await provider.unwrapDek({ ...ids, tenantCmkArn }, wrappedDek);
    expect(Buffer.from(unwrapped).equals(Buffer.from(dek))).toBe(true);

    // wrong engagement in the context must fail the unwrap
    await expect(
      provider.unwrapDek({ ...ids, engagementId: 'e-2' as never, tenantCmkArn }, wrappedDek),
    ).rejects.toThrow();
  });
});
