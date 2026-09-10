import { Global, Inject, Injectable, Module, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Connection, WorkflowClient } from '@temporalio/client';
import type { EngagementId, TenantId } from '@fde/core';

import type { Env } from '../config/env.js';
import { loadTemporalClientConfig } from './temporal-connection.js';

/** DI token for the lazily-connecting `WorkflowClient`, or `null` when Temporal is unconfigured. */
export const TEMPORAL_WORKFLOW_CLIENT = Symbol('TEMPORAL_WORKFLOW_CLIENT');
/** DI token for the task queue the connector-sync worker listens on. */
export const TEMPORAL_TASK_QUEUE = Symbol('TEMPORAL_TASK_QUEUE');

/**
 * Workflow type + default task queue — must match `apps/workers`
 * (`workflows/connector-sync.ts` `connectorSyncWorkflow`, `task-queue.ts`
 * `DEFAULT_TASK_QUEUE`). Duplicated because `@fde/workers` has no package entry
 * point; keep in sync.
 */
const CONNECTOR_SYNC_WORKFLOW_TYPE = 'connectorSyncWorkflow';
const DEFAULT_TASK_QUEUE = 'fde-default';

/** Shape must match `apps/workers` `ConnectorSyncWorkflowInput`. */
export interface ConnectorSyncStartInput {
  tenantId: TenantId;
  engagementId: EngagementId;
  connectorId: string;
  mode: 'backfill' | 'incremental';
}

/**
 * The one Temporal operation the `/admin` API needs: start a
 * `connectorSyncWorkflow`. Wraps the optional `WorkflowClient` so callers get a
 * clean 503 both when Temporal is unconfigured and when it is configured but
 * unreachable (the client connects lazily, so the first RPC is where a down
 * Temporal surfaces).
 */
@Injectable()
export class TemporalConnectorSync {
  constructor(
    @Inject(TEMPORAL_WORKFLOW_CLIENT) private readonly client: WorkflowClient | null,
    @Inject(TEMPORAL_TASK_QUEUE) private readonly taskQueue: string,
  ) {}

  get configured(): boolean {
    return this.client !== null;
  }

  async start(input: ConnectorSyncStartInput): Promise<{ workflowId: string }> {
    if (!this.client) {
      throw new ServiceUnavailableException(
        'Temporal is not configured — set TEMPORAL_ADDRESS to enable connector sync from the API',
      );
    }
    const workflowId = `connector-sync-${input.engagementId}-${input.connectorId}-${Date.now()}`;
    try {
      await this.client.start(CONNECTOR_SYNC_WORKFLOW_TYPE, {
        taskQueue: this.taskQueue,
        workflowId,
        args: [input],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new ServiceUnavailableException(`could not reach Temporal: ${message}`);
    }
    return { workflowId };
  }
}

@Global()
@Module({
  providers: [
    {
      provide: TEMPORAL_WORKFLOW_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): WorkflowClient | null => {
        // Read the whole validated env once; the loader returns null when
        // TEMPORAL_ADDRESS is unset (throws only on a half-configured auth pair).
        const env = {
          TEMPORAL_ADDRESS: config.get('TEMPORAL_ADDRESS', { infer: true }),
          TEMPORAL_NAMESPACE: config.get('TEMPORAL_NAMESPACE', { infer: true }),
          TEMPORAL_API_KEY: config.get('TEMPORAL_API_KEY', { infer: true }),
          TEMPORAL_CLIENT_CERT: config.get('TEMPORAL_CLIENT_CERT', { infer: true }),
          TEMPORAL_CLIENT_KEY: config.get('TEMPORAL_CLIENT_KEY', { infer: true }),
        } as Env;
        const cfg = loadTemporalClientConfig(env);
        if (!cfg) return null;
        // Lazy: no socket opened here, so a down Temporal never blocks boot.
        const connection = Connection.lazy(cfg.connection);
        return new WorkflowClient({ connection, namespace: cfg.namespace });
      },
    },
    {
      provide: TEMPORAL_TASK_QUEUE,
      inject: [ConfigService],
      useFactory: (config: ConfigService<Env, true>): string =>
        config.get('TEMPORAL_TASK_QUEUE', { infer: true }) ?? DEFAULT_TASK_QUEUE,
    },
    TemporalConnectorSync,
  ],
  exports: [TemporalConnectorSync],
})
export class TemporalModule {}
