import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, type OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/** Where `write-openapi.ts` writes the spec — consumed later by a generated client. */
export const OPENAPI_PATH = new URL('../openapi.json', import.meta.url);

/** Builds the OpenAPI document for the running app. Shared by `main.ts` and the writer script. */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('FDE Context Platform API')
    .setDescription('HTTP seam — WorkOS auth + request-scoped tenant/engagement context.')
    .setVersion('0.1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        description: 'the opaque session token from /auth/callback',
      },
      'bearer',
    )
    .build();
  return SwaggerModule.createDocument(app, config);
}
