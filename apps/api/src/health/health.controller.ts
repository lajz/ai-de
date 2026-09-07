import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiProperty, ApiTags } from '@nestjs/swagger';

import { Public } from '../request-context/metadata.js';

class HealthResponse {
  @ApiProperty({ type: String, example: 'ok' })
  status!: 'ok';
}

@ApiTags('health')
@Controller()
export class HealthController {
  /** Liveness probe — no auth, no database. */
  @Public()
  @Get('healthz')
  @ApiOkResponse({ type: HealthResponse })
  healthz(): HealthResponse {
    return { status: 'ok' };
  }
}
