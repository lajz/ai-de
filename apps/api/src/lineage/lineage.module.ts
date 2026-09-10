import { Module } from '@nestjs/common';

import { LineageController } from './lineage.controller.js';
import { LineageService } from './lineage.service.js';

/** `/admin` data-lineage read views — provenance chain, entity graph, pipeline status. */
@Module({
  controllers: [LineageController],
  providers: [LineageService],
})
export class LineageModule {}
