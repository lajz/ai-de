import 'reflect-metadata';

import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';

import { AppModule } from './app.module.js';
import type { Env } from './config/env.js';
import { buildOpenApiDocument } from './openapi.js';

async function bootstrap(): Promise<void> {
  // rawBody: true so the WorkOS webhook receiver can verify the signature over
  // the exact bytes (see auth/webhook.controller.ts).
  const app = await NestFactory.create(AppModule, { rawBody: true });
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
