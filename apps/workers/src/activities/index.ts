import type { KeyProvider } from '@fde/crypto';
import type { Database } from '@fde/db';

import type { RecallClient } from '../capture/recall-client.js';
import { createCaptureSessionActivities } from './capture-session.js';
import { createDescribeEngagementActivity } from './describe-engagement.js';
import { pingActivity } from './ping.js';

export interface ActivityDeps {
  db: Database;
  keyProvider: KeyProvider;
  recallClient: RecallClient;
}

/** Builds the activity map registered with the `Worker`. DI point for `db` / `keyProvider` / `recallClient`. */
export function createActivities(deps: ActivityDeps) {
  return {
    pingActivity,
    describeEngagementActivity: createDescribeEngagementActivity(deps),
    ...createCaptureSessionActivities(deps),
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
