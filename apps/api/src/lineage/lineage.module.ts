import { Module } from '@nestjs/common';

import { LineageController } from './lineage.controller.js';
import { LineageService } from './lineage.service.js';

/**
 * `/admin` data-lineage read views — provenance chain, entity graph, pipeline
 * status. Exports `LineageService` so `RetrievalModule`'s `AgenticQaService`
 * can wrap it as an MCP tool (`get_fact_provenance`/`get_entity_provenance`/
 * `get_graph`) alongside `RetrievalService`.
 */
@Module({
  controllers: [LineageController],
  providers: [LineageService],
  exports: [LineageService],
})
export class LineageModule {}
