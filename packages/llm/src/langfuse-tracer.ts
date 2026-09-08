import { Langfuse } from 'langfuse';

import {
  assertRedacted,
  NoopTracer,
  type RedactedGeneration,
  type RedactedTraceInput,
  type TraceHandle,
  type Tracer,
} from './tracing.js';

/**
 * The slice of the Langfuse client this tracer uses. A test injects a fake here
 * (`client`) instead of letting the constructor build a real one.
 */
export interface LangfuseClientLike {
  trace(body: Record<string, unknown>): LangfuseTraceLike;
  flushAsync(): Promise<void>;
  shutdownAsync(): Promise<void>;
}
export interface LangfuseTraceLike {
  generation(body: Record<string, unknown>): unknown;
  update(body: Record<string, unknown>): unknown;
}

export interface LangfuseTracerConfig {
  publicKey?: string;
  secretKey?: string;
  /** self-hosted, in-VPC per `docs/architecture.md` */
  baseUrl?: string;
  /** test seam — inject a client (or a fake) instead of building a real one */
  client?: LangfuseClientLike;
  /** strings that must never appear in an emitted payload (tests seed a canary) */
  redactionCanaries?: readonly string[];
  /** cap on concurrently-open traces; extra `startTrace` calls no-op (bounded queue) */
  maxOpenTraces?: number;
}

const DEFAULT_MAX_OPEN_TRACES = 512;

let warnedQueueFull = false;

/**
 * Redacted Langfuse tracer. Every payload passes `assertRedacted` before it can
 * reach the transport, so a content string cannot get onto the wire even if a
 * caller mis-builds one. Fire-and-forget: `startTrace` / `generation` / `end`
 * never block on IO and never throw into the caller — a Langfuse outage costs
 * traces, never extraction. The underlying SDK batches and flushes on an
 * interval; `flush()` / `shutdown()` drain it.
 */
export class LangfuseTracer implements Tracer {
  private readonly client: LangfuseClientLike;
  private readonly canaries: readonly string[];
  private readonly maxOpen: number;
  private open = 0;

  constructor(config: LangfuseTracerConfig = {}) {
    this.canaries = config.redactionCanaries ?? [];
    this.maxOpen = config.maxOpenTraces ?? DEFAULT_MAX_OPEN_TRACES;
    // The SDK gets the keys only via this constructor (used for an auth header,
    // not echoed into errors); we never log an SDK error — `swallow` drops them.
    this.client =
      config.client ??
      (new Langfuse({
        publicKey: config.publicKey,
        secretKey: config.secretKey,
        baseUrl: config.baseUrl,
        // Batch; a full batch or the interval flushes in the background.
        flushAt: 25,
        flushInterval: 5_000,
        fetchRetryCount: 2,
      }) as unknown as LangfuseClientLike);
  }

  startTrace(input: RedactedTraceInput): TraceHandle {
    try {
      assertRedacted(input, this.canaries);
    } catch {
      // A payload we cannot prove is redacted is dropped, not sent.
      return NOOP_HANDLE;
    }
    if (this.open >= this.maxOpen) {
      if (!warnedQueueFull) {
        warnedQueueFull = true;
        console.warn('@fde/llm: Langfuse trace queue full — dropping traces until it drains');
      }
      return NOOP_HANDLE;
    }
    this.open += 1;

    let trace: LangfuseTraceLike;
    try {
      trace = this.client.trace({
        name: input.name,
        metadata: pruneUndefined({
          extractionRunId: input.extractionRunId,
          sourceId: input.sourceId,
          chunkCount: input.chunkCount,
        }),
      });
    } catch {
      this.open -= 1;
      return NOOP_HANDLE;
    }

    let closed = false;
    const close = (): void => {
      if (!closed) {
        closed = true;
        this.open -= 1;
        if (this.open === 0) warnedQueueFull = false; // re-arm the warning once drained
      }
    };
    return {
      generation: (gen) => {
        if (closed) return;
        try {
          assertRedacted(gen, this.canaries);
          trace.generation(toGenerationBody(gen));
        } catch {
          /* swallow — tracing must never break the caller */
        }
      },
      end: (end) => {
        if (closed) return; // idempotent — a second end() is a no-op
        try {
          if (end) {
            assertRedacted(end, this.canaries);
            trace.update({ metadata: pruneUndefined({ ...end }) });
          }
        } catch {
          /* swallow */
        } finally {
          close();
        }
      },
    };
  }

  async flush(): Promise<void> {
    await this.swallow(() => this.client.flushAsync());
  }

  async shutdown(): Promise<void> {
    await this.swallow(() => this.client.shutdownAsync());
  }

  private async swallow(fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch {
      /* a Langfuse transport failure must not surface here */
    }
  }
}

const NOOP_HANDLE: TraceHandle = { generation() {}, end() {} };

function toGenerationBody(gen: RedactedGeneration): Record<string, unknown> {
  return {
    name: gen.name,
    model: gen.model,
    usageDetails: {
      input: gen.inputTokens,
      output: gen.outputTokens,
      cache_read_input_tokens: gen.cacheReadInputTokens,
      cache_creation_input_tokens: gen.cacheCreationInputTokens,
    },
    metadata: pruneUndefined({
      provider: gen.provider,
      tier: gen.tier,
      promptName: gen.promptName,
      promptVersion: gen.promptVersion,
      outcome: gen.outcome,
      costUsd: gen.costUsd,
      latencyMs: gen.latencyMs,
      inputHash: gen.inputHash,
      outputHash: gen.outputHash,
    }),
  };
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;
}

let warnedPartialKeys = false;

/**
 * `LangfuseTracer` when both `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are
 * set, else `NoopTracer`. Tracing is optional, so a missing pair is not an error;
 * only one key set warns once (keys and paths are never logged).
 */
export function createTracerFromEnv(env: NodeJS.ProcessEnv = process.env): Tracer {
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  if (publicKey && secretKey) {
    return new LangfuseTracer({ publicKey, secretKey, baseUrl: env.LANGFUSE_BASE_URL });
  }
  if ((publicKey || secretKey) && !warnedPartialKeys) {
    warnedPartialKeys = true;
    console.warn(
      '@fde/llm: only one of LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY is set — tracing disabled',
    );
  }
  return new NoopTracer();
}
