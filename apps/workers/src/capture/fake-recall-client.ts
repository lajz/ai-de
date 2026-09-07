import { randomUUID } from 'node:crypto';

import type {
  CaptureBotState,
  RecallClient,
  ScheduleBotInput,
  ScheduledBot,
  TranscriptSegment,
} from './recall-client.js';

/** A short, fixed two-speaker script — deterministic transcript content for tests. */
export const DEFAULT_FAKE_TRANSCRIPT: TranscriptSegment[] = [
  {
    speaker: 'Alice Rivera',
    words: [
      { text: 'Welcome', start: 0, end: 0.4 },
      { text: 'everyone,', start: 0.4, end: 0.9 },
      { text: "let's", start: 0.9, end: 1.1 },
      { text: 'get', start: 1.1, end: 1.3 },
      { text: 'started.', start: 1.3, end: 1.8 },
    ],
  },
  {
    speaker: 'Bob Chen',
    words: [
      { text: 'Thanks', start: 2.0, end: 2.3 },
      { text: 'Alice.', start: 2.3, end: 2.7 },
      { text: 'We', start: 2.7, end: 2.9 },
      { text: 'decided', start: 2.9, end: 3.3 },
      { text: 'to', start: 3.3, end: 3.4 },
      { text: 'ship', start: 3.4, end: 3.7 },
      { text: 'Friday.', start: 3.7, end: 4.2 },
    ],
  },
];

export interface FakeRecallOptions {
  /** getBot calls before the bot reports `done` (default 1 — done on the first poll) */
  pollsUntilDone?: number;
  /** report a terminal `failed` on the Nth getBot call instead of ever completing */
  failOnPoll?: number;
  failureReason?: string;
  /** never report `done` — exercises the workflow's capture-timeout path */
  neverCompletes?: boolean;
  /** transcript returned once `done` (default `DEFAULT_FAKE_TRANSCRIPT`) */
  transcript?: TranscriptSegment[];
}

interface FakeBot {
  polls: number;
  scheduledFor: string;
  meetingUrl: string;
}

/**
 * Dependency-free `RecallClient`. No network, no timers: a bot advances purely
 * by the number of `getBot` calls, so a workflow test driving it under
 * `TestWorkflowEnvironment`'s time-skipping clock is fully reproducible. Bot ids
 * are random (opaque by contract) so two instances don't collide on the
 * `capture_sessions.bot_id` unique constraint.
 */
export class FakeRecallClient implements RecallClient {
  private readonly bots = new Map<string, FakeBot>();
  private readonly opts: Required<Omit<FakeRecallOptions, 'failOnPoll'>> & { failOnPoll?: number };

  constructor(options: FakeRecallOptions = {}) {
    this.opts = {
      // when a failure poll is configured but no completion poll is, the bot
      // never reaches `done` on its own — it fails first
      pollsUntilDone:
        options.pollsUntilDone ?? (options.failOnPoll !== undefined ? Number.POSITIVE_INFINITY : 1),
      failOnPoll: options.failOnPoll,
      failureReason: options.failureReason ?? 'bot removed from the call',
      neverCompletes: options.neverCompletes ?? false,
      transcript: options.transcript ?? DEFAULT_FAKE_TRANSCRIPT,
    };
  }

  /** Bot ids handed out so far — lets a test assert the schedule activity ran exactly once. */
  get scheduledBotIds(): string[] {
    return [...this.bots.keys()];
  }

  async scheduleBot(input: ScheduleBotInput): Promise<ScheduledBot> {
    const botId = `fake-bot-${randomUUID()}`;
    this.bots.set(botId, { polls: 0, scheduledFor: input.joinAt, meetingUrl: input.meetingUrl });
    return { botId };
  }

  async getBot(botId: string): Promise<CaptureBotState> {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`FakeRecallClient: unknown bot ${botId}`);
    bot.polls += 1;

    if (this.opts.failOnPoll !== undefined && bot.polls >= this.opts.failOnPoll) {
      return { botId, status: 'failed', failureReason: this.opts.failureReason };
    }
    if (!this.opts.neverCompletes && bot.polls >= this.opts.pollsUntilDone) {
      return { botId, status: 'done' };
    }
    return { botId, status: bot.polls === 1 ? 'joining' : 'in_call' };
  }

  async getTranscript(botId: string): Promise<TranscriptSegment[]> {
    const bot = this.bots.get(botId);
    if (!bot) throw new Error(`FakeRecallClient: unknown bot ${botId}`);
    // deep copy so a caller mutating segments can't corrupt a later call
    return this.opts.transcript.map((s) => ({
      speaker: s.speaker,
      words: s.words.map((w) => ({ ...w })),
    }));
  }
}
