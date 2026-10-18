import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';
import { MAX_CUSTOM_INGEST_BYTES } from './integrations/integrations-ingest.controller.js';
import { buildOpenApiDocument } from './openapi.js';

async function bootstrap(): Promise<void> {
  // rawBody: true so the WorkOS webhook receiver can verify the signature over
  // the exact bytes (see auth/webhook.controller.ts).
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { rawBody: true });
  // Express's default 100kb JSON cap would silently undercut the 256KiB custom
  // integration ingest limit (`MAX_CUSTOM_INGEST_BYTES`, enforced in its controller).
  app.useBodyParser('json', { limit: MAX_CUSTOM_INGEST_BYTES });
  app.enableShutdownHooks();

  const config: ConfigService<Env, true> = app.get(ConfigService);

  SwaggerModule.setup('docs', app, buildOpenApiDocument(app));

  const port = config.get('PORT', { infer: true });
  await app.listen(port);
  new Logger('bootstrap').log(`API on :${port} — OpenAPI UI at /docs`);
}

bootstrap().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  new Logger('bootstrap').error(`failed to start: ${message}`);
  process.exitCode = 1;
});
