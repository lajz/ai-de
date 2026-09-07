import type { KeyProvider } from '@fde/crypto';
import type { Database } from '@fde/db';

import { createDescribeEngagementActivity } from './describe-engagement.js';
import { pingActivity } from './ping.js';

export interface ActivityDeps {
  db: Database;
  keyProvider: KeyProvider;
}

/** Builds the activity map registered with the `Worker`. DI point for `db` / `keyProvider`. */
export function createActivities(deps: ActivityDeps) {
  return {
    pingActivity,
    describeEngagementActivity: createDescribeEngagementActivity(deps),
  };
}

export type Activities = ReturnType<typeof createActivities>;

export { withEngagementActivity, type EngagementActivityContext } from './engagement-context.js';
export {
  type DescribeEngagementInput,
  type DescribeEngagementResult,
} from './describe-engagement.js';
export { type PingActivityInput, type PingActivityResult } from './ping.js';
