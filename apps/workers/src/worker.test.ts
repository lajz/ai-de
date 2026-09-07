import { FakeKeyProvider, KmsKeyProvider } from '@fde/crypto';
import { describe, expect, it } from 'vitest';

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
