import { FakeRecallClient } from './fake-recall-client.js';
import { DEFAULT_RECALL_BASE_URL, HttpRecallClient } from './http-recall-client.js';
import type { RecallClient } from './recall-client.js';

/**
 * Client selection: the real `HttpRecallClient` when `RECALL_API_KEY` is set,
 * the deterministic `FakeRecallClient` otherwise — so local dev and CI run the
 * capture workflow end to end without a Recall account, and production is a
 * config flip. A missing key in production is a misconfiguration, not a silent
 * fallback to a fake.
 */
export function loadRecallClient(env: NodeJS.ProcessEnv): RecallClient {
  if (env.RECALL_API_KEY) {
    return new HttpRecallClient({
      apiKey: env.RECALL_API_KEY,
      baseUrl: env.RECALL_API_BASE_URL ?? DEFAULT_RECALL_BASE_URL,
    });
  }
  if (env.NODE_ENV === 'production') {
    throw new Error('RECALL_API_KEY is required when NODE_ENV=production');
  }
  return new FakeRecallClient();
}

export {
  FakeRecallClient,
  DEFAULT_FAKE_TRANSCRIPT,
  type FakeRecallOptions,
} from './fake-recall-client.js';
export {
  HttpRecallClient,
  DEFAULT_RECALL_BASE_URL,
  type HttpRecallClientOptions,
} from './http-recall-client.js';
export {
  RecallApiError,
  type RecallClient,
  type ScheduleBotInput,
  type ScheduledBot,
  type CaptureBotState,
  type CaptureBotStatus,
  type TranscriptSegment,
  type TranscriptWord,
} from './recall-client.js';
