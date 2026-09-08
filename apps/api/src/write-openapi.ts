import 'reflect-metadata';

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Writes `apps/api/openapi.json` from the live route metadata, for a generated
 * client to consume later. Boots the module graph but never opens a socket or a
 * DB connection (the `postgres` pool connects lazily), so a placeholder
 * `DATABASE_URL` is enough when none is set.
 *
 * `@nestjs/config`'s `forRoot()` validates the environment at module-evaluation
 * time, so the placeholder must be set before `app.module.js` is imported —
 * hence the dynamic imports below.
 */
async function main(): Promise<void> {
  process.env.DATABASE_URL ??= 'postgres://placeholder:placeholder@localhost:5432/placeholder';

  const { NestFactory } = await import('@nestjs/core');
  const { AppModule } = await import('./app.module.js');
  const { buildOpenApiDocument, OPENAPI_PATH } = await import('./openapi.js');

  const app = await NestFactory.create(AppModule, { logger: ['error', 'warn'], rawBody: true });
  await app.init();
  const document = buildOpenApiDocument(app);
  const path = fileURLToPath(OPENAPI_PATH);
  writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`);
  await app.close();
  process.stdout.write(`wrote ${path}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`write-openapi failed: ${err instanceof Error ? err.stack : String(err)}\n`);
  process.exitCode = 1;
});
