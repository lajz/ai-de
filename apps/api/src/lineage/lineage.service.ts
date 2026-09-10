import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type AclPrincipalRule,
  ENTITY_TYPES,
  type EngagementId,
  type EntityType,
  PREDICATES,
  type Predicate,
  type TenantId,
  type UserId,
} from '@fde/core';
import { logAccess } from '@fde/audit';
import { AuthzClient } from '@fde/authz';
import {
  CRYPTO_COLUMNS,
  selectConnectorSyncStates,
  selectExtractionRun,
  selectFactForProvenance,
  selectGraphEdges,
  selectGraphEntities,
  selectGraphFacts,
  selectPipelineRollups,
  selectProvenanceEvidence,
  selectRecentExtractionRuns,
} from '@fde/db';
import type { EngagementCipher } from '@fde/crypto';

import type { Env } from '../config/env.js';
import { getEngagementContext, getRequestContext } from '../request-context/request-context.js';

const FACTS_BODY_PATH = CRYPTO_COLUMNS.facts[0].path;
const EVIDENCE_QUOTE_PATH = CRYPTO_COLUMNS.evidence[0].path;
const ACL_RULES_PATH = CRYPTO_COLUMNS.acl_snapshots[0].path;

/** Cap on `relationships` edges returned by `GET …/graph`. */
export const GRAPH_EDGE_CAP = 2000;
/** Default `extraction_runs` window for `GET …/pipeline`. */
export const PIPELINE_RUN_LIMIT = 20;

export interface AclSnapshotSummary {
  ruleCount: number;
  /** distinct `scope` values across the rules — e.g. `slack_channel`, `gdrive_file` */
  principalKinds: string[];
  capturedAt: string | null;
  ttlSeconds: number | null;
}

export interface ProvenanceEvidence {
  quote: string | null;
  charStart: number | null;
  charEnd: number | null;
  relation: string;
  source: {
    id: string;
    connector: string;
    externalId: string;
    kind: string;
    urlPermalink: string | null;
    occurredAt: string;
  };
  acl: AclSnapshotSummary | null;
}

export interface FactProvenance {
  fact: {
    id: string;
    type: string;
    summary: string;
    body: string | null;
    status: string;
    confidence: number | null;
    occurredAt: string | null;
    createdAt: string;
  };
  evidence: ProvenanceEvidence[];
  extractionRun: {
    model: string;
    promptVersion: string;
    costUsd: number | null;
    createdAt: string;
  } | null;
}

export interface GraphNode {
  id: string;
  kind: 'entity' | 'fact';
  type: string;
  /** entities: `displayName`; facts: `summary` */
  label: string;
  status?: string;
  externalRefs?: unknown[];
}

export interface GraphEdge {
  id: string;
  fromKind: string;
  fromId: string;
  predicate: string;
  toKind: string;
  toId: string;
  sourceId: string | null;
}

export interface EngagementGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
}

export interface PipelineStatus {
  syncStates: {
    connector: string;
    status: string;
    lastRunAt: string | null;
    cursorPresent: boolean;
    updatedAt: string;
  }[];
  recentExtractionRuns: {
    model: string;
    promptVersion: string;
    costUsd: number | null;
    inputSourceCount: number;
    createdAt: string;
  }[];
  rollups: {
    totalFacts: number;
    totalEmbeddings: number;
    totalCostUsd: number;
    sourcesByConnector: Record<string, number>;
  };
}

/**
 * Data-lineage read path for the `/admin` provenance / graph / pipeline views.
 * Same seam discipline as `RetrievalService`: no DB code of its own (reads `tx`
 * from `getRequestContext()`), `canViewEngagement`-gated under `AUTHZ_ENFORCE`,
 * 🔒 fields decrypted only *after* that gate, and every decrypting read writes a
 * `content_read` `access_log` row in the request transaction. `graph` and
 * `pipeline` touch no 🔒 column, so they log nothing.
 */
@Injectable()
export class LineageService {
  private readonly enforce: boolean;

  constructor(
    @Inject(AuthzClient) private readonly authz: AuthzClient,
    @Inject(ConfigService) config: ConfigService<Env, true>,
  ) {
    this.enforce = config.get('AUTHZ_ENFORCE', { infer: true }) === 'true';
  }

  /** The full provenance chain for one fact: fact → evidence → source → ACL → extraction run. */
  async getFactProvenance(factId: string): Promise<FactProvenance> {
    const { tx, userId, tenantId } = getRequestContext();
    const engagement = getEngagementContext();
    await this.assertCanView(userId, tenantId, engagement.id);

    const fact = await selectFactForProvenance(tx, tenantId, engagement.id, factId);
    if (!fact) throw new NotFoundException('fact not found in this engagement');

    const evRows = await selectProvenanceEvidence(tx, tenantId, engagement.id, factId);
    const run = fact.extractionRunId
      ? await selectExtractionRun(tx, tenantId, engagement.id, fact.extractionRunId)
      : undefined;

    await logAccess(tx, {
      tenantId,
      actorType: 'user',
      actorId: userId,
      action: 'content_read',
      engagementId: engagement.id,
      resourceType: 'facts',
      resourceId: factId,
    });

    const evidence: ProvenanceEvidence[] = [];
    for (const e of evRows) {
      evidence.push({
        quote: await decryptString(engagement.cipher, EVIDENCE_QUOTE_PATH, e.quote),
        charStart: e.charStart,
        charEnd: e.charEnd,
        relation: e.relation,
        source: {
          id: e.sourceId,
          connector: e.connector,
          externalId: e.externalId,
          kind: e.kind,
          urlPermalink: e.urlPermalink,
          occurredAt: e.occurredAt.toISOString(),
        },
        acl: await summarizeAcl(engagement.cipher, e),
      });
    }

    return {
      fact: {
        id: fact.id,
        type: fact.type,
        summary: fact.summary,
        body: await decryptString(engagement.cipher, FACTS_BODY_PATH, fact.body),
        status: fact.status,
        confidence: fact.confidence,
        occurredAt: fact.occurredAt ? fact.occurredAt.toISOString() : null,
        createdAt: fact.createdAt.toISOString(),
      },
      evidence,
      extractionRun: run
        ? {
            model: run.model,
            promptVersion: run.promptVersion,
            costUsd: run.costUsd,
            createdAt: run.createdAt.toISOString(),
          }
        : null,
    };
  }

  /** The engagement's provenance graph (cleartext columns only). */
  async getGraph(filter: { entityType?: string; predicate?: string }): Promise<EngagementGraph> {
    const { tx, userId, tenantId } = getRequestContext();
    const engagement = getEngagementContext();
    await this.assertCanView(userId, tenantId, engagement.id);

    const entityType = parseEnum(filter.entityType, ENTITY_TYPES, 'entityType') as
      EntityType | undefined;
    const predicate = parseEnum(filter.predicate, PREDICATES, 'predicate') as Predicate | undefined;

    const entityRows = await selectGraphEntities(tx, tenantId, engagement.id, { entityType });
    // A fact node is not an entity — when `entityType` narrows the entities, drop fact nodes.
    const factRows = entityType ? [] : await selectGraphFacts(tx, tenantId, engagement.id);
    const edgeRows = await selectGraphEdges(tx, tenantId, engagement.id, {
      predicate,
      limit: GRAPH_EDGE_CAP + 1,
    });
    const truncated = edgeRows.length > GRAPH_EDGE_CAP;

    const nodes: GraphNode[] = [
      ...entityRows.map((e) => ({
        id: e.id,
        kind: 'entity' as const,
        type: e.type,
        label: e.displayName,
        externalRefs: e.externalRefs,
      })),
      ...factRows.map((f) => ({
        id: f.id,
        kind: 'fact' as const,
        type: f.type,
        label: f.summary,
        status: f.status,
      })),
    ];

    return {
      nodes,
      edges: edgeRows.slice(0, GRAPH_EDGE_CAP).map((r) => ({
        id: r.id,
        fromKind: r.fromKind,
        fromId: r.fromId,
        predicate: r.predicate,
        toKind: r.toKind,
        toId: r.toId,
        sourceId: r.sourceId,
      })),
      truncated,
    };
  }

  /** Operational health: sync state per connector, recent extraction runs, rollups. */
  async getPipeline(limit = PIPELINE_RUN_LIMIT): Promise<PipelineStatus> {
    const { tx, userId, tenantId } = getRequestContext();
    const engagement = getEngagementContext();
    await this.assertCanView(userId, tenantId, engagement.id);

    const [states, runs, rollups] = await Promise.all([
      selectConnectorSyncStates(tx, tenantId, engagement.id),
      selectRecentExtractionRuns(tx, tenantId, engagement.id, limit),
      selectPipelineRollups(tx, tenantId, engagement.id),
    ]);

    return {
      syncStates: states.map((s) => ({
        connector: s.connector,
        status: s.status,
        lastRunAt: s.lastRunAt ? s.lastRunAt.toISOString() : null,
        cursorPresent: s.cursor != null,
        updatedAt: s.updatedAt.toISOString(),
      })),
      recentExtractionRuns: runs.map((r) => ({
        model: r.model,
        promptVersion: r.promptVersion,
        costUsd: r.costUsd,
        inputSourceCount: r.inputSourceIds.length,
        createdAt: r.createdAt.toISOString(),
      })),
      rollups: {
        totalFacts: rollups.totalFacts,
        totalEmbeddings: rollups.totalEmbeddings,
        totalCostUsd: rollups.totalCostUsd,
        sourcesByConnector: rollups.sourcesByConnector,
      },
    };
  }

  // --- internals --------------------------------------------------------

  private async assertCanView(
    userId: UserId,
    tenantId: TenantId,
    engagementId: EngagementId,
  ): Promise<void> {
    if (!this.enforce) return;
    await this.authz.linkEngagementToTenant(engagementId, tenantId);
    if (!(await this.authz.canViewEngagement(userId, engagementId))) {
      throw new ForbiddenException('not authorized to view this engagement');
    }
  }
}

/** `?entityType=` / `?predicate=` — undefined passes through, an unknown value is a 400. */
function parseEnum(
  value: string | undefined,
  allowed: readonly string[],
  name: string,
): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (!allowed.includes(value)) {
    throw new BadRequestException(`${name} must be one of: ${allowed.join(', ')}`);
  }
  return value;
}

async function decryptString(
  cipher: EngagementCipher,
  path: string,
  value: unknown,
): Promise<string | null> {
  if (value == null) return null;
  return cipher.decryptString(path, value as Parameters<EngagementCipher['decryptString']>[1]);
}

async function summarizeAcl(
  cipher: EngagementCipher,
  row: {
    aclPrincipalRules: unknown;
    aclCapturedAt: Date | null;
    aclTtlSeconds: number | null;
  },
): Promise<AclSnapshotSummary | null> {
  if (row.aclPrincipalRules == null) return null;
  const rules = (await cipher.decryptJson(
    ACL_RULES_PATH,
    row.aclPrincipalRules as Parameters<EngagementCipher['decryptJson']>[1],
  )) as AclPrincipalRule[];
  return {
    ruleCount: rules.length,
    principalKinds: [...new Set(rules.map((r) => r.scope))].sort(),
    capturedAt: row.aclCapturedAt ? row.aclCapturedAt.toISOString() : null,
    ttlSeconds: row.aclTtlSeconds,
  };
}
