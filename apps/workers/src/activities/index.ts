import type { ConnectorRegistry, NangoClient } from '@fde/connectors';
import type { KeyProvider } from '@fde/crypto';
import type { Database } from '@fde/db';
import type { EmbeddingClient, Router, Tracer } from '@fde/llm';

import type { RecallClient } from '../capture/recall-client.js';
import { createCaptureSessionActivities } from './capture-session.js';
import { createConnectorSyncActivities } from './connector-sync.js';
import { createDescribeEngagementActivity } from './describe-engagement.js';
import { createExtractionActivities } from './extraction-pipeline.js';
import { pingActivity } from './ping.js';

export interface ActivityDeps {
  db: Database;
  keyProvider: KeyProvider;
  recallClient: RecallClient;
  /** connector id → factory; drives the generic `ConnectorSync` workflow */
  connectors: ConnectorRegistry;
  /** self-hosted Nango — mints OAuth tokens for `nango-oauth` connectors (Linear) */
  nango: NangoClient;
  router: Router;
  embeddingClient: EmbeddingClient;
  /** redacted LLM tracing — `NoopTracer` when Langfuse is unconfigured */
  tracer: Tracer;
}

/**
 * Builds the activity map registered with the `Worker`. DI point for `db` /
 * `keyProvider` / `recallClient` / `connectors` / `nango` / `router` /
 * `embeddingClient` / `tracer`.
 */
export function createActivities(deps: ActivityDeps) {
  return {
    pingActivity,
    describeEngagementActivity: createDescribeEngagementActivity(deps),
    ...createCaptureSessionActivities(deps),
    ...createExtractionActivities(deps),
    ...createConnectorSyncActivities(deps),
  };
}

export type Activities = ReturnType<typeof createActivities>;

export { withEngagementActivity, type EngagementActivityContext } from './engagement-context.js';
export {
  type DescribeEngagementInput,
  type DescribeEngagementResult,
} from './describe-engagement.js';
export { type PingActivityInput, type PingActivityResult } from './ping.js';
export {
  type CaptureSessionActivitiesDeps,
  type CaptureSessionActivities,
  type ScheduleCaptureBotInput,
  type ScheduleCaptureBotResult,
  type PollCaptureBotInput,
  type PollCaptureBotResult,
  type StoreTranscriptSourceInput,
  type StoreTranscriptSourceResult,
} from './capture-session.js';
export {
  RECALL_CONNECTOR,
  REPROCESSING_WINDOW_MS,
  buildTranscriptSource,
  renderTranscriptText,
  type BuildTranscriptSourceInput,
  type BuiltTranscriptSource,
  type TranscriptSourceRow,
} from './transcript-source.js';
export { chunkTranscript, type ChunkOptions, type TranscriptChunk } from './chunk-transcript.js';
export {
  createConnectorSyncActivities,
  type ConnectorSyncActivitiesDeps,
  type ConnectorSyncActivities,
  type ConnectorSyncMode,
  type GraphWriteTally,
  type RunConnectorSyncInput,
  type RunConnectorSyncResult,
} from './connector-sync.js';
export {
  buildConnectorSource,
  connectorContentHash,
  type BuildConnectorSourceInput,
  type BuiltConnectorSource,
  type ConnectorSourceRow,
} from './connector-source.js';
export {
  createExtractionActivities,
  type ExtractionActivitiesDeps,
  type ExtractionActivities,
  type RunExtractionInput,
  type RunExtractionResult,
  type PurgeRawBodyInput,
  type PurgeRawBodyResult,
} from './extraction-pipeline.js';
