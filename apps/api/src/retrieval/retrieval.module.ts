import { Module } from '@nestjs/common';
import {
  createEmbeddingClientFromEnv,
  createRouter,
  type EmbeddingClient,
  type Router,
} from '@fde/llm';

import { RetrievalService } from './retrieval.service.js';
import { QUERY_EMBEDDING_CLIENT, ROUTER } from './retrieval.tokens.js';

/**
 * The engagement read path (#9). Owns one process-wide `@fde/llm` `Router` and a
 * query-semantics embedding client; both are built from the environment the same
 * way `@fde/workers` builds its extraction-side pair (fake-able — the router
 * onUsage sink is the #11 Langfuse seam, unused here). Tests bind fakes over the
 * `ROUTER` / `QUERY_EMBEDDING_CLIENT` tokens.
 */
@Module({
  providers: [
    { provide: ROUTER, useFactory: (): Router => createRouter({ onUsage: () => {} }) },
    {
      provide: QUERY_EMBEDDING_CLIENT,
      useFactory: (): EmbeddingClient =>
        createEmbeddingClientFromEnv(process.env, { inputType: 'query' }),
    },
    RetrievalService,
  ],
  exports: [RetrievalService],
})
export class RetrievalModule {}
