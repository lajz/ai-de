import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';

import { LlmError } from './errors.js';
import type { UsageRecord, UsageSink } from './types.js';

/**
 * Redacted LLM tracing. `docs/architecture.md`: **Langfuse receives redacted
 * traces only** — token counts, prompt version, latency, cost, ids, coarse
 * outcome, and hashes; never a prompt, a transcript, a model response, or a
 * fact/evidence body. Everything in this module is metadata-by-construction, and
 * `assertRedacted` is the boundary `LangfuseTracer` runs every payload through
 * before it can reach the wire.
 */

/** Coarse call outcome. Never carries the offending content. */
export type TraceOutcome = 'ok' | 'schema-fail' | 'provider-error';

/** SHA-256 hex — a stable fingerprint of an input/output without the text itself. */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

// --- Redacted shapes (metadata only) -----------------------------------------

export interface RedactedTraceInput {
  /** short, static label — e.g. `extraction.run` */
  name: string;
  extractionRunId?: string;
  sourceId?: string;
  chunkCount?: number;
}

export interface RedactedGeneration {
  /** short, static label — e.g. `extraction.chunk` */
  name: string;
  provider: string;
  model: string;
  tier: string;
  promptName?: string;
  promptVersion: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number;
  latencyMs: number;
  outcome: TraceOutcome;
  /** optional SHA-256 fingerprints — hashes, never the text */
  inputHash?: string;
  outputHash?: string;
}

export interface RedactedTraceEnd {
  chunkCount?: number;
  factCount?: number;
  embeddingCount?: number;
  unlocatableSpanCount?: number;
  usdCost?: number;
  okChunks?: number;
  failedChunks?: number;
}

// --- The redaction boundary --------------------------------------------------

/**
 * Every key a redacted payload is allowed to carry. A key outside this set — or a
 * non-scalar leaf, or an over-long string — means content could be leaking.
 *
 * `extractionRunId` / `sourceId` are internal opaque ids (also stored cleartext
 * on `extraction_runs` — `docs/architecture.md`: "lineage, no content") and are
 * explicitly in scope for the redacted trace; they carry no tenant or customer
 * identity.
 */
export const REDACTED_KEYS: ReadonlySet<string> = new Set([
  'name',
  'extractionRunId',
  'sourceId',
  'chunkCount',
  'provider',
  'model',
  'tier',
  'promptName',
  'promptVersion',
  'inputTokens',
  'outputTokens',
  'cacheReadInputTokens',
  'cacheCreationInputTokens',
  'costUsd',
  'latencyMs',
  'outcome',
  'inputHash',
  'outputHash',
  'factCount',
  'embeddingCount',
  'unlocatableSpanCount',
  'usdCost',
  'okChunks',
  'failedChunks',
]);

/**
 * Upper bound on any string in a redacted payload. Labels, model ids, outcomes,
 * and 64-char hex hashes all sit well under it; a transcript quote or a model
 * sentence does not.
 */
const MAX_STRING = 120;

/**
 * Keys whose value is a short, code-defined label — held to a stricter shape than
 * the generic string cap so a caller can't smuggle a sentence into one.
 */
const LABEL_KEYS: ReadonlySet<string> = new Set(['name', 'outcome']);
const LABEL_RE = /^[a-z][a-z0-9._-]{0,39}$/i;

/** A payload could not be proven free of content and was refused. */
export class RedactionError extends LlmError {}

/**
 * Throw `RedactionError` unless `value` is metadata-only: every object key in
 * `REDACTED_KEYS`, every leaf a scalar, every string `<= MAX_STRING` chars,
 * `LABEL_KEYS` matching `LABEL_RE`, and no string containing any entry of
 * `forbid` (tests seed a content canary here).
 */
export function assertRedacted(value: unknown, forbid: readonly string[] = []): void {
  const walk = (node: unknown, path: string, key?: string): void => {
    if (
      node === null ||
      node === undefined ||
      typeof node === 'number' ||
      typeof node === 'boolean'
    ) {
      return;
    }
    if (typeof node === 'string') {
      if (key && LABEL_KEYS.has(key) && !LABEL_RE.test(node)) {
        throw new RedactionError(`${path}: not a valid short label`);
      }
      if (node.length > MAX_STRING) {
        throw new RedactionError(`${path}: string exceeds ${MAX_STRING} chars`);
      }
      for (const needle of forbid) {
        if (needle && node.includes(needle)) {
          throw new RedactionError(`${path}: forbidden substring reached the tracer`);
        }
      }
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((child, i) => walk(child, `${path}[${i}]`));
      return;
    }
    if (typeof node === 'object') {
      for (const [k, child] of Object.entries(node)) {
        if (!REDACTED_KEYS.has(k)) {
          throw new RedactionError(`${path}.${k}: key not in the redaction allowlist`);
        }
        walk(child, `${path}.${k}`, k);
      }
      return;
    }
    throw new RedactionError(`${path}: unsupported value type ${typeof node}`);
  };
  walk(value, '$');
}

/** Project a content-free `UsageRecord` onto a `RedactedGeneration`, field by field. */
export function redactUsage(
  usage: UsageRecord,
  extra: {
    name: string;
    promptName?: string;
    outcome: TraceOutcome;
    inputHash?: string;
    outputHash?: string;
  },
): RedactedGeneration {
  return {
    name: extra.name,
    provider: usage.provider,
    model: usage.model,
    tier: usage.tier,
    promptName: extra.promptName,
    promptVersion: usage.promptVersion,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cacheReadInputTokens: usage.cacheReadInputTokens,
    cacheCreationInputTokens: usage.cacheCreationInputTokens,
    costUsd: usage.costUsd,
    latencyMs: usage.latencyMs,
    outcome: extra.outcome,
    ...(extra.inputHash ? { inputHash: extra.inputHash } : {}),
    ...(extra.outputHash ? { outputHash: extra.outputHash } : {}),
  };
}

// --- Tracer seam ------------------------------------------------------------

export interface TraceHandle {
  generation(gen: RedactedGeneration): void;
  end(end?: RedactedTraceEnd): void;
}

export interface Tracer {
  /**
   * Open a trace. The caller **must** call `handle.end()` exactly once (use
   * `traceExtraction`, which does this in a `finally`) — `LangfuseTracer` uses
   * the open/end pair to bound its in-flight queue.
   */
  startTrace(input: RedactedTraceInput): TraceHandle;
  /** best-effort drain of anything queued. Never throws. */
  flush(): Promise<void>;
  /** flush + release resources. Never throws. Call on worker shutdown. */
  shutdown(): Promise<void>;
}

const NOOP_HANDLE: TraceHandle = { generation() {}, end() {} };

/** Default tracer — records nothing. Tracing is optional (`docs/architecture.md`). */
export class NoopTracer implements Tracer {
  startTrace(): TraceHandle {
    return NOOP_HANDLE;
  }
  async flush(): Promise<void> {}
  async shutdown(): Promise<void> {}
}

export interface RecordedTrace {
  input: RedactedTraceInput;
  generations: RedactedGeneration[];
  end?: RedactedTraceEnd;
  ended: boolean;
}

/** In-memory tracer for tests — keeps every span verbatim for assertions. */
export class FakeTracer implements Tracer {
  readonly traces: RecordedTrace[] = [];
  flushCalls = 0;
  shutdownCalls = 0;

  startTrace(input: RedactedTraceInput): TraceHandle {
    const rec: RecordedTrace = { input, generations: [], ended: false };
    this.traces.push(rec);
    return {
      generation: (gen) => {
        if (!rec.ended) rec.generations.push(gen);
      },
      end: (end) => {
        if (rec.ended) return; // idempotent — matches the startTrace contract
        rec.end = end;
        rec.ended = true;
      },
    };
  }
  async flush(): Promise<void> {
    this.flushCalls += 1;
  }
  async shutdown(): Promise<void> {
    this.shutdownCalls += 1;
  }

  /** every generation across every trace — handy for canary assertions */
  get generations(): RedactedGeneration[] {
    return this.traces.flatMap((t) => t.generations);
  }
}

// --- Wiring over the router's onUsage sink ----------------------------------

const activeTrace = new AsyncLocalStorage<TraceHandle>();

/** The trace this async context is running inside, if any. */
export function currentTrace(): TraceHandle | undefined {
  return activeTrace.getStore();
}

/**
 * Turn the router's `onUsage` stream into redacted generations. Inside a
 * `traceExtraction` scope the run owns its own per-chunk recording, so this sink
 * stays out of the way; otherwise every model call becomes a one-off trace.
 */
export function tracingUsageSink(tracer: Tracer): UsageSink {
  return (record) => {
    if (currentTrace()) return;
    const handle = tracer.startTrace({ name: 'llm.call' });
    handle.generation(redactUsage(record, { name: 'llm.generation', outcome: 'ok' }));
    handle.end();
  };
}

/**
 * Run `fn` as one trace: the run shows as a single trace with per-chunk
 * generations underneath. `fn` gets the handle to record generations and call
 * `end()` with the run tally; if it doesn't `end()`, this closes the trace so it
 * never dangles.
 */
export async function traceExtraction<T>(
  tracer: Tracer,
  input: Omit<RedactedTraceInput, 'name'>,
  fn: (trace: TraceHandle) => Promise<T>,
): Promise<T> {
  const handle = tracer.startTrace({ name: 'extraction.run', ...input });
  let ended = false;
  const guarded: TraceHandle = {
    generation: (gen) => {
      if (!ended) handle.generation(gen);
    },
    end: (end) => {
      if (ended) return; // idempotent — a second end() is a no-op
      ended = true;
      handle.end(end);
    },
  };
  try {
    return await activeTrace.run(guarded, () => fn(guarded));
  } finally {
    // Always close the trace; a throwing custom tracer must not mask fn's result.
    if (!ended) {
      try {
        handle.end();
      } catch {
        /* ignore */
      }
    }
  }
}
