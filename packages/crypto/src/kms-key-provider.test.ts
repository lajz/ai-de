import { CreateKeyCommand, DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { describe, expect, it, vi } from 'vitest';

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

  it('rewrapDek moves a DEK to a second CMK without changing the key material', async () => {
    const provider = new KmsKeyProvider({ client });
    const { KeyMetadata: cmkA } = await client.send(new CreateKeyCommand({}));
    const { KeyMetadata: cmkB } = await client.send(new CreateKeyCommand({}));
    const tenantCmkArn = cmkA!.Arn!;

    const { dek, wrappedDek } = await provider.generateDek({ ...ids, tenantCmkArn });
    const rewrapped = await provider.rewrapDek({ ...ids, tenantCmkArn }, wrappedDek, {
      ...ids,
      tenantCmkArn,
      byokKeyArn: cmkB!.Arn!,
    });

    // same key material, now recoverable only under the new key
    const unwrapped = await provider.unwrapDek(
      { ...ids, tenantCmkArn, byokKeyArn: cmkB!.Arn! },
      rewrapped,
    );
    expect(Buffer.from(unwrapped).equals(Buffer.from(dek))).toBe(true);
    // the old wrap under CMK A is untouched and still resolves the same DEK
    const stillUnderA = await provider.unwrapDek({ ...ids, tenantCmkArn }, wrappedDek);
    expect(Buffer.from(stillUnderA).equals(Buffer.from(dek))).toBe(true);
  });
});

describe('KmsKeyProvider.rewrapDek (mocked client — no LocalStack needed)', () => {
  const ids = { tenantId: 't-1' as never, engagementId: 'e-1' as never };

  it('does a Decrypt under the old key then an Encrypt (never GenerateDataKey) under the new key', async () => {
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof DecryptCommand) return { Plaintext: Buffer.alloc(32, 7) };
      if (cmd instanceof EncryptCommand) return { CiphertextBlob: Buffer.from('new-wrapped') };
      throw new Error(
        `unexpected KMS command: ${(cmd as { constructor: { name: string } }).constructor.name}`,
      );
    });
    const provider = new KmsKeyProvider({ client: { send } as unknown as KMSClient });

    const result = await provider.rewrapDek(
      { ...ids, tenantCmkArn: 'arn:old' },
      Buffer.from('old-wrapped'),
      { ...ids, tenantCmkArn: 'arn:old', byokKeyArn: 'arn:new' },
    );

    expect(Buffer.from(result).toString()).toBe('new-wrapped');
    expect(send).toHaveBeenCalledTimes(2);
    const [decryptCmd, encryptCmd] = send.mock.calls.map(
      (c) => c[0] as { input: { KeyId: string } },
    );
    expect(decryptCmd).toBeInstanceOf(DecryptCommand);
    expect(decryptCmd.input.KeyId).toBe('arn:old');
    expect(encryptCmd).toBeInstanceOf(EncryptCommand);
    expect(encryptCmd.input.KeyId).toBe('arn:new');
  });

  it('fails closed: an Encrypt failure under the new key propagates and never returns a wrapped value', async () => {
    const send = vi.fn(async (cmd: unknown) => {
      if (cmd instanceof DecryptCommand) return { Plaintext: Buffer.alloc(32, 7) };
      throw new Error('AccessDeniedException: cross-account grant not found');
    });
    const provider = new KmsKeyProvider({ client: { send } as unknown as KMSClient });

    await expect(
      provider.rewrapDek({ ...ids, tenantCmkArn: 'arn:old' }, Buffer.from('old-wrapped'), {
        ...ids,
        tenantCmkArn: 'arn:old',
        byokKeyArn: 'arn:bad',
      }),
    ).rejects.toThrow(/grant not found/);
  });
});
