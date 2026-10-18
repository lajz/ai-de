import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiTags } from '@nestjs/swagger';

import { EngagementScope } from '../request-context/metadata.js';
import {
  IntegrationsService,
  type CustomIntegrationView,
  type CustomIntegrationWithSecret,
  type TestMappingResult,
} from './integrations.service.js';

/**
 * `/engagements/:id/integrations` — admin CRUD for self-serve custom
 * integrations. Bodies are validated in the service (zod) so a bad mapping is a
 * 422 with per-field issues, not a generic 400.
 */
@ApiTags('integrations')
@ApiBearerAuth()
@Controller('engagements')
export class IntegrationsController {
  constructor(@Inject(IntegrationsService) private readonly integrations: IntegrationsService) {}

  @Get(':id/integrations')
  @EngagementScope('id')
  @ApiOkResponse()
  list(@Param('id', new ParseUUIDPipe()) _id: string): Promise<CustomIntegrationView[]> {
    return this.integrations.list();
  }

  // Declared before the `:integrationId` routes so `test` is never read as an id.
  @Post(':id/integrations/test')
  @HttpCode(200)
  @EngagementScope('id')
  @ApiOkResponse()
  test(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Body() body: unknown,
  ): Promise<TestMappingResult> {
    return this.integrations.test(body);
  }

  @Post(':id/integrations')
  @EngagementScope('id')
  @ApiOkResponse()
  create(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Body() body: unknown,
  ): Promise<CustomIntegrationWithSecret> {
    return this.integrations.create(body);
  }

  @Get(':id/integrations/:integrationId')
  @EngagementScope('id')
  @ApiOkResponse()
  get(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('integrationId', new ParseUUIDPipe()) integrationId: string,
  ): Promise<CustomIntegrationView> {
    return this.integrations.get(integrationId);
  }

  @Put(':id/integrations/:integrationId')
  @EngagementScope('id')
  @ApiOkResponse()
  update(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('integrationId', new ParseUUIDPipe()) integrationId: string,
    @Body() body: unknown,
  ): Promise<CustomIntegrationView> {
    return this.integrations.update(integrationId, body);
  }

  @Delete(':id/integrations/:integrationId')
  @HttpCode(204)
  @EngagementScope('id')
  async remove(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('integrationId', new ParseUUIDPipe()) integrationId: string,
  ): Promise<void> {
    await this.integrations.remove(integrationId);
  }

  @Post(':id/integrations/:integrationId/rotate-secret')
  @HttpCode(200)
  @EngagementScope('id')
  @ApiOkResponse()
  rotateSecret(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('integrationId', new ParseUUIDPipe()) integrationId: string,
  ): Promise<CustomIntegrationWithSecret> {
    return this.integrations.rotateSecret(integrationId);
  }
}
