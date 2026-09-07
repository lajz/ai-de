import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FakeKeyProvider, KmsKeyProvider, type KeyProvider } from '@fde/crypto';

import type { Env } from '../config/env.js';

/** Injection token for the `@fde/crypto` `KeyProvider`. */
export const KEY_PROVIDER = Symbol('KEY_PROVIDER');

/**
 * The engagement-DEK unwrap seam. Real `KmsKeyProvider` from `AWS_REGION` +
 * ambient AWS credentials; `FakeKeyProvider` when `FDE_FAKE_KMS=true`
 * (dev/test only — `envSchema` already refuses that flag under
 * `NODE_ENV=production`). Mirrors `loadKeyProvider` in `@fde/workers`.
 */
export function loadKeyProvider(config: ConfigService<Env, true>): KeyProvider {
  if (config.get('FDE_FAKE_KMS', { infer: true }) === 'true') {
    return new FakeKeyProvider();
  }
  const region = config.get('AWS_REGION', { infer: true });
  return new KmsKeyProvider(region ? { region } : {});
}

@Global()
@Module({
  providers: [
    {
      provide: KEY_PROVIDER,
      inject: [ConfigService],
      useFactory: loadKeyProvider,
    },
  ],
  exports: [KEY_PROVIDER],
})
export class KeyProviderModule {}
