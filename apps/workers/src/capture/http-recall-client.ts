import {
  RecallApiError,
  type CaptureBotState,
  type CaptureBotStatus,
  type RecallClient,
  type ScheduleBotInput,
  type ScheduledBot,
  type TranscriptSegment,
} from './recall-client.js';

/**
 * Recall runs one API host per region; the key is region-bound. Pay-as-you-go
 * keys use `https://api.recall.ai`. Override with `RECALL_API_BASE_URL`.
 */
export const DEFAULT_RECALL_BASE_URL = 'https://us-west-2.recall.ai';

export interface HttpRecallClientOptions {
  apiKey: string;
  /** region host, no trailing slash (default `DEFAULT_RECALL_BASE_URL`) */
  baseUrl?: string;
  /**
   * `recording_config.transcript.provider` value. Default `{ meeting_captions: {} }`
   * — the platform's own live captions, cheapest and needs no extra vendor. Swap
   * for `{ assembly_ai: {…} }` etc. per the Recall docs.
   */
  transcriptProvider?: Record<string, unknown>;
  botName?: string;
  /** injectable for tests; defaults to global `fetch` */
  fetchImpl?: typeof fetch;
}

// --- Recall wire shapes (kept private to this module) ---------------------

interface RecallBotResponse {
  id: string;
  status_changes?: Array<{ code?: string; message?: string | null; created_at?: string }>;
  /** legacy top-level status object some API versions still return */
  status?: { code?: string; message?: string | null } | null;
}

interface RecallTranscriptEntry {
  // legacy `GET /bot/{id}/transcript/` shape
  speaker?: string | null;
  speaker_id?: number | null;
  words?: Array<{
    text?: string;
    start_timestamp?: number | { relative?: number } | null;
    end_timestamp?: number | { relative?: number } | null;
  }>;
  // newer diarized shape
  participant?: { id?: number | null; name?: string | null } | null;
}

/** Recall status-change `code` → our normalized status. Unknown codes keep us polling. */
function normalizeStatus(code: string | undefined): CaptureBotStatus {
  switch (code) {
    case undefined:
      return 'scheduled';
    case 'ready':
    case 'joining_call':
    case 'in_waiting_room':
      return 'joining';
    case 'in_call_not_recording':
    case 'in_call_recording':
    case 'recording_permission_allowed':
    case 'participant_events':
    case 'call_ended':
      // `call_ended` = meeting over, Recall still processing — not done yet
      return 'in_call';
    case 'recording_done':
    case 'done':
    case 'analysis_done':
      return 'done';
    case 'recording_permission_denied':
    case 'call_not_started':
    case 'bot_rejected':
    case 'timeout':
    case 'fatal':
    case 'internal_error':
      return 'failed';
    default:
      return 'joining';
  }
}

function relativeSeconds(ts: number | { relative?: number } | null | undefined): number | null {
  if (ts == null) return null;
  if (typeof ts === 'number') return Number.isFinite(ts) ? ts : null;
  return typeof ts.relative === 'number' ? ts.relative : null;
}

function normalizeTranscript(entries: RecallTranscriptEntry[]): TranscriptSegment[] {
  return entries.map((e) => ({
    speaker: e.speaker ?? e.participant?.name ?? null,
    words: (e.words ?? []).map((w) => ({
      text: w.text ?? '',
      start: relativeSeconds(w.start_timestamp),
      end: relativeSeconds(w.end_timestamp),
    })),
  }));
}

/**
 * Real Recall.ai client. Untested against the live API until `RECALL_API_KEY`
 * lands — exercised only by `recall-client.smoke.test.ts`
 * (`describe.skipIf(!RECALL_API_KEY)`). Everything above `RecallClient` runs on
 * `FakeRecallClient`.
 */
export class HttpRecallClient implements RecallClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly transcriptProvider: Record<string, unknown>;
  private readonly botName: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: HttpRecallClientOptions) {
    if (!options.apiKey) throw new Error('HttpRecallClient: apiKey is required');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? DEFAULT_RECALL_BASE_URL).replace(/\/$/, '');
    this.transcriptProvider = options.transcriptProvider ?? { meeting_captions: {} };
    this.botName = options.botName ?? 'FDE Context Notetaker';
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Token ${this.apiKey}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        accept: 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (!res.ok) {
      // Recall error bodies are small JSON like `{"detail":"..."}` — safe to
      // surface (no transcript content). Cap length defensively.
      const detail = await res.text().catch(() => '');
      throw new RecallApiError(res.status, method, path, detail.slice(0, 500));
    }
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  async scheduleBot(input: ScheduleBotInput): Promise<ScheduledBot> {
    const bot = await this.request<RecallBotResponse>('POST', '/api/v1/bot/', {
      meeting_url: input.meetingUrl,
      bot_name: input.botName ?? this.botName,
      join_at: input.joinAt,
      recording_config: { transcript: { provider: this.transcriptProvider } },
    });
    return { botId: bot.id };
  }

  async getBot(botId: string): Promise<CaptureBotState> {
    const bot = await this.request<RecallBotResponse>(
      'GET',
      `/api/v1/bot/${encodeURIComponent(botId)}/`,
    );
    const changes = bot.status_changes ?? [];
    const latest = changes[changes.length - 1]?.code ?? bot.status?.code ?? undefined;
    const status = normalizeStatus(latest);
    return {
      botId,
      status,
      ...(status === 'failed'
        ? {
            failureReason:
              changes[changes.length - 1]?.message ?? bot.status?.message ?? latest ?? 'unknown',
          }
        : {}),
    };
  }

  async getTranscript(botId: string): Promise<TranscriptSegment[]> {
    const path = `/api/v1/bot/${encodeURIComponent(botId)}/transcript/`;
    const entries = await this.request<unknown>('GET', path);
    // Some API versions wrap the list; accept the common shapes, but a
    // non-array, non-wrapped body is a malformed response, not "no transcript".
    const list = Array.isArray(entries)
      ? entries
      : Array.isArray((entries as { results?: unknown })?.results)
        ? (entries as { results: RecallTranscriptEntry[] }).results
        : Array.isArray((entries as { transcript?: unknown })?.transcript)
          ? (entries as { transcript: RecallTranscriptEntry[] }).transcript
          : null;
    if (!list) {
      throw new RecallApiError(200, 'GET', path, 'transcript response was not a list');
    }
    return normalizeTranscript(list);
  }
}
