import {
  BadRequestException,
  Controller,
  Headers,
  Inject,
  Post,
  type RawBodyRequest,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Request } from 'express';

import { Public } from '../request-context/metadata.js';
import { DirectorySyncService, type DirectorySyncOutcome } from './directory-sync.service.js';
import { WORKOS, type WorkOsPort } from './workos.types.js';

/**
 * WorkOS webhook receiver (Directory Sync / SCIM). The signature over the raw
 * body is verified against `WORKOS_WEBHOOK_SECRET` before anything else — an
 * unverified request never reaches `DirectorySyncService`.
 */
@ApiExcludeController()
@Controller('webhooks/workos')
export class WebhookController {
  constructor(
    @Inject(WORKOS) private readonly workos: WorkOsPort,
    @Inject(DirectorySyncService) private readonly directorySync: DirectorySyncService,
  ) {}

  @Public()
  @Post()
  async receive(
    @Req() req: RawBodyRequest<Request>,
    @Headers('workos-signature') signature: string | undefined,
  ): Promise<DirectorySyncOutcome> {
    if (req.rawBody === undefined) {
      // `main.ts` / the test harness create the app with `rawBody: true`; if the
      // exact bytes weren't captured we cannot verify the signature — fail, never
      // fall back to an empty body.
      throw new BadRequestException('raw request body unavailable — cannot verify signature');
    }
    const event = await this.workos.verifyEvent(req.rawBody.toString('utf8'), signature);
    return this.directorySync.apply(event);
  }
}
