import { FakeKeyProvider, KmsKeyProvider } from '@fde/crypto';
import { describe, expect, it } from 'vitest';

import { FakeRecallClient, HttpRecallClient, loadRecallClient } from './capture/index.js';
import { loadKeyProvider } from './worker.js';

describe('loadKeyProvider', () => {
  it('defaults to KmsKeyProvider', () => {
    expect(loadKeyProvider({})).toBeInstanceOf(KmsKeyProvider);
  });

  it('FDE_FAKE_KMS=true selects FakeKeyProvider outside production', () => {
    expect(loadKeyProvider({ FDE_FAKE_KMS: 'true' })).toBeInstanceOf(FakeKeyProvider);
    expect(loadKeyProvider({ FDE_FAKE_KMS: 'true', NODE_ENV: 'development' })).toBeInstanceOf(
      FakeKeyProvider,
    );
  });

  it('refuses FDE_FAKE_KMS=true when NODE_ENV=production', () => {
    expect(() => loadKeyProvider({ FDE_FAKE_KMS: 'true', NODE_ENV: 'production' })).toThrow(
      /not allowed when NODE_ENV=production/,
    );
  });
});

describe('loadRecallClient', () => {
  it('uses the real HttpRecallClient when RECALL_API_KEY is set', () => {
    expect(loadRecallClient({ RECALL_API_KEY: 'k' })).toBeInstanceOf(HttpRecallClient);
  });

  it('falls back to FakeRecallClient outside production when the key is absent', () => {
    expect(loadRecallClient({})).toBeInstanceOf(FakeRecallClient);
    expect(loadRecallClient({ NODE_ENV: 'development' })).toBeInstanceOf(FakeRecallClient);
  });

  it('refuses to run without a key when NODE_ENV=production', () => {
    expect(() => loadRecallClient({ NODE_ENV: 'production' })).toThrow(
      /RECALL_API_KEY is required/,
    );
  });
});
