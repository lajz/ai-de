import { Controller, Get, Inject, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import { EVIDENCE_RELATIONS, NODE_KINDS, PREDICATES } from '@fde/core';

import { EngagementScope } from '../request-context/metadata.js';
import { LineageService } from './lineage.service.js';

class AclSummaryResponse {
  @ApiProperty({ type: Number }) ruleCount!: number;
  @ApiProperty({ type: [String], description: 'distinct rule scopes (e.g. slack_channel)' })
  principalKinds!: string[];
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) capturedAt!: string | null;
  @ApiProperty({ type: Number, nullable: true }) ttlSeconds!: number | null;
}

class ProvenanceSourceResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) connector!: string;
  @ApiProperty({ type: String }) externalId!: string;
  @ApiProperty({ type: String }) kind!: string;
  @ApiProperty({ type: String, nullable: true }) urlPermalink!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'e.g. a Slack/Nango workspace id' })
  workspaceRef!: string | null;
  @ApiProperty({ type: String, nullable: true, description: 'e.g. a channel/doc/meeting id' })
  containerRef!: string | null;
  @ApiProperty({ type: String, nullable: true, description: "the artifact's author/speaker ref" })
  authorRef!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) occurredAt!: string;
}

class ProvenanceEvidenceResponse {
  @ApiProperty({ type: String, nullable: true, description: 'decrypted supporting quote' })
  quote!: string | null;
  @ApiProperty({ type: Number, nullable: true }) charStart!: number | null;
  @ApiProperty({ type: Number, nullable: true }) charEnd!: number | null;
  @ApiProperty({ type: String, enum: [...EVIDENCE_RELATIONS] }) relation!: string;
  @ApiProperty({ type: ProvenanceSourceResponse }) source!: ProvenanceSourceResponse;
  @ApiProperty({ type: AclSummaryResponse, nullable: true }) acl!: AclSummaryResponse | null;
}

class ProvenanceFactResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) type!: string;
  @ApiProperty({ type: String }) summary!: string;
  @ApiProperty({ type: String, nullable: true, description: 'decrypted detail' })
  body!: string | null;
  @ApiProperty({ type: String }) status!: string;
  @ApiProperty({ type: Number, nullable: true }) confidence!: number | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) occurredAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

class ExtractionRunResponse {
  @ApiProperty({ type: String }) model!: string;
  @ApiProperty({ type: String }) promptVersion!: string;
  @ApiProperty({ type: Number, nullable: true }) costUsd!: number | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

class FactProvenanceResponse {
  @ApiProperty({ type: ProvenanceFactResponse }) fact!: ProvenanceFactResponse;
  @ApiProperty({ type: [ProvenanceEvidenceResponse] }) evidence!: ProvenanceEvidenceResponse[];
  @ApiProperty({ type: ExtractionRunResponse, nullable: true })
  extractionRun!: ExtractionRunResponse | null;
}

class EntityProvenanceEntityResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) type!: string;
  @ApiProperty({ type: String }) displayName!: string;
}

class EntityDerivationCounterpartResponse {
  @ApiProperty({ type: String, enum: [...NODE_KINDS] }) kind!: string;
  @ApiProperty({ type: String }) id!: string;
}

class EntityDerivationResponse {
  @ApiProperty({ type: String }) relationshipId!: string;
  @ApiProperty({ type: String, enum: [...PREDICATES] }) predicate!: string;
  @ApiProperty({ type: String, enum: ['outgoing', 'incoming'] }) direction!: string;
  @ApiProperty({ type: EntityDerivationCounterpartResponse })
  counterpart!: EntityDerivationCounterpartResponse;
  @ApiProperty({ type: ProvenanceSourceResponse }) source!: ProvenanceSourceResponse;
}

class EntityProvenanceFactResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String }) type!: string;
  @ApiProperty({ type: String }) summary!: string;
}

class EntityProvenanceResponse {
  @ApiProperty({ type: EntityProvenanceEntityResponse }) entity!: EntityProvenanceEntityResponse;
  @ApiProperty({ type: [EntityDerivationResponse] }) derivedFrom!: EntityDerivationResponse[];
  @ApiProperty({ type: [EntityProvenanceFactResponse] }) facts!: EntityProvenanceFactResponse[];
}

class GraphNodeResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, enum: ['entity', 'fact'] }) kind!: string;
  @ApiProperty({ type: String }) type!: string;
  @ApiProperty({ type: String, description: 'entity displayName or fact summary' }) label!: string;
  @ApiPropertyOptional({ type: String }) status?: string;
  @ApiPropertyOptional({ type: [Object] }) externalRefs?: unknown[];
}

class GraphEdgeResponse {
  @ApiProperty({ type: String }) id!: string;
  @ApiProperty({ type: String, enum: ['entity', 'fact'] }) fromKind!: string;
  @ApiProperty({ type: String }) fromId!: string;
  @ApiProperty({ type: String }) predicate!: string;
  @ApiProperty({ type: String, enum: ['entity', 'fact'] }) toKind!: string;
  @ApiProperty({ type: String }) toId!: string;
  @ApiProperty({ type: String, nullable: true }) sourceId!: string | null;
}

class EngagementGraphResponse {
  @ApiProperty({ type: [GraphNodeResponse] }) nodes!: GraphNodeResponse[];
  @ApiProperty({ type: [GraphEdgeResponse] }) edges!: GraphEdgeResponse[];
  @ApiProperty({ type: Boolean, description: 'true when the edge cap was hit' })
  truncated!: boolean;
}

class SyncStateResponse {
  @ApiProperty({ type: String }) connector!: string;
  @ApiProperty({ type: String }) status!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) lastRunAt!: string | null;
  @ApiProperty({ type: Boolean }) cursorPresent!: boolean;
  @ApiProperty({ type: String, format: 'date-time' }) updatedAt!: string;
}

class PipelineRunResponse {
  @ApiProperty({ type: String }) model!: string;
  @ApiProperty({ type: String }) promptVersion!: string;
  @ApiProperty({ type: Number, nullable: true }) costUsd!: number | null;
  @ApiProperty({ type: Number }) inputSourceCount!: number;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: string;
}

class PipelineRollupsResponse {
  @ApiProperty({ type: Number }) totalFacts!: number;
  @ApiProperty({ type: Number }) totalEmbeddings!: number;
  @ApiProperty({ type: Number }) totalCostUsd!: number;
  @ApiProperty({ type: Object, description: 'source count keyed by connector' })
  sourcesByConnector!: Record<string, number>;
}

class PipelineStatusResponse {
  @ApiProperty({ type: [SyncStateResponse] }) syncStates!: SyncStateResponse[];
  @ApiProperty({ type: [PipelineRunResponse] }) recentExtractionRuns!: PipelineRunResponse[];
  @ApiProperty({ type: PipelineRollupsResponse }) rollups!: PipelineRollupsResponse;
}

/**
 * `/admin` data-lineage read views. Engagement-scoped, `canViewEngagement`-gated
 * under `AUTHZ_ENFORCE`. `provenance` decrypts 🔒 quote / body / ACL rules
 * post-gate and logs a `content_read`; `entityProvenance`, `graph` and
 * `pipeline` return cleartext / metadata only.
 */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('engagements')
export class LineageController {
  constructor(@Inject(LineageService) private readonly lineage: LineageService) {}

  @Get(':id/facts/:factId/provenance')
  @EngagementScope('id')
  @ApiOkResponse({ type: FactProvenanceResponse })
  async provenance(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('factId', new ParseUUIDPipe()) factId: string,
  ): Promise<FactProvenanceResponse> {
    return this.lineage.getFactProvenance(factId);
  }

  @Get(':id/entities/:entityId/provenance')
  @EngagementScope('id')
  @ApiOkResponse({ type: EntityProvenanceResponse })
  async entityProvenance(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Param('entityId', new ParseUUIDPipe()) entityId: string,
  ): Promise<EntityProvenanceResponse> {
    return this.lineage.getEntityProvenance(entityId);
  }

  @Get(':id/graph')
  @EngagementScope('id')
  @ApiOkResponse({ type: EngagementGraphResponse })
  async graph(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Query('entityType') entityType?: string,
    @Query('predicate') predicate?: string,
  ): Promise<EngagementGraphResponse> {
    return this.lineage.getGraph({ entityType, predicate });
  }

  @Get(':id/pipeline')
  @EngagementScope('id')
  @ApiOkResponse({ type: PipelineStatusResponse })
  async pipeline(
    @Param('id', new ParseUUIDPipe()) _id: string,
    @Query('limit') limit?: string,
  ): Promise<PipelineStatusResponse> {
    const parsed = limit === undefined ? undefined : Number(limit);
    return this.lineage.getPipeline(
      parsed !== undefined && Number.isFinite(parsed) && parsed > 0
        ? Math.floor(parsed)
        : undefined,
    );
  }
}
