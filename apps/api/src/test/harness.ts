import type { INestApplication } from '@nestjs/common';

import type { FakeWorkOsService } from '../auth/fake-workos.service.js';

/** Shared webhook secret for tests — `createTestApp` sets it into the environment. */
export const TEST_WEBHOOK_SECRET = 'test-webhook-secret';

export interface TestAppOptions {
  /** value to bind for the `DB` token (a fake, or a real `@fde/db` `Database`) */
  db?: unknown;
  /** default true — bind `FakeKeyProvider` via `FDE_FAKE_KMS` */
  fakeKms?: boolean;
  /** value to bind for the `AuthzClient` token — pass an `InMemoryAuthzClient` to seed relationships */
  authz?: unknown;
  /** sets `AUTHZ_ENFORCE` before `AppModule` (→ `@nestjs/config`) evaluates */
  enforceAuthz?: boolean;
}

export interface TestApp {
  app: INestApplication;
  workos: FakeWorkOsService;
  close: () => Promise<void>;
}

/**
 * Boots the real `AppModule` for an e2e / integration test. WorkOS has no API
 * key in the test environment, so the `WORKOS` provider is already the in-memory
 * `FakeWorkOsService` (returned here for `register()` / `signWebhook()`).
 * `AppModule` is imported dynamically so the env below is in place before
 * `@nestjs/config` validates it at module-evaluation time.
 */
export async function createTestApp(opts: TestAppOptions = {}): Promise<TestApp> {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL ??= 'postgres://placeholder:placeholder@localhost:5432/placeholder';
  process.env.WORKOS_WEBHOOK_SECRET ??= TEST_WEBHOOK_SECRET;
  if (opts.fakeKms !== false) process.env.FDE_FAKE_KMS = 'true';
  process.env.AUTHZ_ENFORCE = opts.enforceAuthz ? 'true' : 'false';

  const { Test } = await import('@nestjs/testing');
  const { AppModule } = await import('../app.module.js');
  const { DB } = await import('../db/db.module.js');
  const { WORKOS } = await import('../auth/workos.types.js');
  const { AuthzClient } = await import('@fde/authz');

  let builder = Test.createTestingModule({ imports: [AppModule] });
  if (opts.db !== undefined) {
    builder = builder.overrideProvider(DB).useValue(opts.db);
  }
  if (opts.authz !== undefined) {
    builder = builder.overrideProvider(AuthzClient).useValue(opts.authz);
  }
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication({ rawBody: true });
  await app.init();

  return {
    app,
    workos: moduleRef.get<FakeWorkOsService>(WORKOS, { strict: false }),
    close: () => app.close(),
  };
}
