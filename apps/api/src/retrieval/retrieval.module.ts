import { Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import {
  createEmbeddingClientFromEnv,
  createRouter,
  createTracerFromEnv,
  tracingUsageSink,
  type EmbeddingClient,
  type Router,
  type Tracer,
} from '@fde/llm';

import { LineageModule } from '../lineage/lineage.module.js';
import { AgenticQaService } from './agentic-qa.service.js';
import { RetrievalService } from './retrieval.service.js';
import { QUERY_EMBEDDING_CLIENT, ROUTER, TRACER } from './retrieval.tokens.js';

/**
 * The engagement read path (#9). Owns one process-wide `@fde/llm` `Router`, a
 * query-semantics embedding client, and a redacted-tracing `Tracer` — same
 * `createTracerFromEnv`/`tracingUsageSink` seam `apps/workers` wires
 * (`worker.ts`). This is the first time `apps/api` traces to Langfuse: the
 * one-shot `answerQuestion` path and the agentic loop both go through the
 * same `Router` instance, so both get traced uniformly rather than picking
 * one path to instrument. Tests bind fakes over the `ROUTER` /
 * `QUERY_EMBEDDING_CLIENT` / `TRACER` tokens.
 */
@Module({
  imports: [LineageModule],
  providers: [
    { provide: TRACER, useFactory: (): Tracer => createTracerFromEnv(process.env) },
    {
      provide: ROUTER,
      inject: [TRACER],
      useFactory: (tracer: Tracer): Router => createRouter({ onUsage: tracingUsageSink(tracer) }),
    },
    {
      provide: QUERY_EMBEDDING_CLIENT,
      useFactory: (): EmbeddingClient =>
        createEmbeddingClientFromEnv(process.env, { inputType: 'query' }),
    },
    RetrievalService,
    AgenticQaService,
  ],
  exports: [RetrievalService, AgenticQaService],
})
export class RetrievalModule implements OnApplicationShutdown {
  constructor(@Inject(TRACER) private readonly tracer: Tracer) {}

  async onApplicationShutdown(): Promise<void> {
    await this.tracer.shutdown(); // flush queued redacted spans; never throws
  }
}
