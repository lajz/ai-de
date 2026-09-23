import { Inject, Injectable, Logger } from '@nestjs/common';
import type { MCPCallToolResultLike, MCPClientLike } from '@anthropic-ai/sdk/helpers/beta/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { EngagementId, TenantId, UserId } from '@fde/core';
import { type KeyProvider } from '@fde/crypto';
import { type Database } from '@fde/db';
import {
  AGENTIC_QA_PROMPT_NAME,
  redactUsage,
  traceAgentLoop,
  type Router,
  type TraceHandle,
  type Tracer,
} from '@fde/llm';
import { createDbToolDeps, createMcpServer, withToolContext } from '@fde/mcp';

import { DB } from '../db/db.module.js';
import { KEY_PROVIDER } from '../key-provider/key-provider.module.js';
import { LineageService } from '../lineage/lineage.service.js';
import { ROUTER, TRACER } from './retrieval.tokens.js';
import { RetrievalService, type QaCitation, type QaResult } from './retrieval.service.js';

/** LLM API requests per question — Tool Runner's own `max_iterations` bound. */
export const MAX_LLM_TURNS = 6;
/** Tool calls per question — checked independently, since a turn could always call a tool. */
export const MAX_TOOL_CALLS = 4;

export type AgenticQaEvent =
  | { type: 'tool_step'; tool: string; status: 'started' | 'ok' | 'error' }
  | { type: 'answer'; answer: string; citations: QaCitation[] }
  | { type: 'error'; message: string };

export interface AgenticQaContext {
  tenantId: TenantId;
  userId: UserId;
  engagementId: EngagementId;
}

/**
 * Drives an agentic Q&A turn: an in-process MCP server (`@fde/mcp`, bound to
 * one caller + engagement, never model-controlled — see `createMcpServer`'s
 * doc comment) wired to `client.beta.messages.toolRunner` via
 * `Router.runAgentLoop` (`@fde/llm`). Falls back to the existing one-shot
 * `RetrievalService.answerQuestion` if the loop errors, or exceeds
 * `MAX_TOOL_CALLS`/`MAX_LLM_TURNS` without producing an answer — the same
 * guaranteed-answer contract the one-shot route always had.
 *
 * Each MCP tool call opens its own short-lived `withEngagement` transaction
 * (`@fde/mcp`'s `withToolContext`) — there is no ambient request transaction
 * held open for the life of this (potentially long, streamed) call. The
 * controller route driving this service is `@NoTransactionScope()`.
 */
@Injectable()
export class AgenticQaService {
  private readonly logger = new Logger(AgenticQaService.name);

  constructor(
    @Inject(RetrievalService) private readonly retrieval: RetrievalService,
    @Inject(LineageService) private readonly lineage: LineageService,
    @Inject(DB) private readonly db: Database,
    @Inject(KEY_PROVIDER) private readonly keyProvider: KeyProvider,
    @Inject(ROUTER) private readonly router: Router,
    @Inject(TRACER) private readonly tracer: Tracer,
  ) {}

  async *ask(question: string, ctx: AgenticQaContext): AsyncGenerator<AgenticQaEvent> {
    const queue = new AsyncQueue<AgenticQaEvent>();

    const runPromise = traceAgentLoop(this.tracer, { engagementId: ctx.engagementId }, (trace) =>
      this.runLoop(question, ctx, trace, queue),
    )
      .catch(async (err) => {
        this.logger.warn(`agentic loop failed, falling back to one-shot: ${errorMessage(err)}`);
        await this.emitFallback(question, ctx, queue);
      })
      .finally(() => queue.close());

    yield* queue;
    await runPromise;
  }

  private async runLoop(
    question: string,
    ctx: AgenticQaContext,
    trace: TraceHandle,
    queue: AsyncQueue<AgenticQaEvent>,
  ): Promise<void> {
    const mcpDeps = createDbToolDeps(this.db, this.keyProvider, this.retrieval, this.lineage);
    const mcpServer = createMcpServer(mcpDeps, ctx);
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const mcpClient = new Client({ name: 'ai-de-agentic-qa', version: '0.0.0' });

    let toolCallCount = 0;
    let stepIndex = 0;
    let lastText = '';
    let turnToolName: string | undefined;
    let stepCapExceeded = false;
    const citations: QaCitation[] = [];

    try {
      await Promise.all([mcpServer.connect(serverTransport), mcpClient.connect(clientTransport)]);
      const { tools } = await mcpClient.listTools();

      for await (const event of this.router.runAgentLoop({
        tier: 'default',
        prompt: { name: AGENTIC_QA_PROMPT_NAME },
        messages: question,
        maxIterations: MAX_LLM_TURNS,
        mcpTools: tools,
        mcpClient: asMcpClientLike(mcpClient),
      })) {
        if (event.type === 'tool_call') {
          toolCallCount += 1;
          turnToolName = event.name;
          queue.push({ type: 'tool_step', tool: event.name, status: 'started' });
          if (toolCallCount > MAX_TOOL_CALLS) {
            stepCapExceeded = true;
            break;
          }
        } else if (event.type === 'tool_result') {
          queue.push({
            type: 'tool_step',
            tool: event.name,
            status: event.isError ? 'error' : 'ok',
          });
          if (event.name === 'search_context' && !event.isError) {
            citations.push(...extractSearchContextCitations(event.content));
          }
        } else if (event.type === 'text') {
          lastText = event.text;
        } else if (event.type === 'usage') {
          trace.generation(
            redactUsage(event.usage, {
              name: 'qa.agentic.turn',
              outcome: 'ok',
              toolName: turnToolName,
              stepIndex,
            }),
          );
          stepIndex += 1;
          turnToolName = undefined;
        }
      }
    } finally {
      await mcpClient.close().catch(() => {});
      await mcpServer.close().catch(() => {});
    }

    if (stepCapExceeded || !lastText) {
      await this.emitFallback(question, ctx, queue);
      trace.end({ okChunks: stepIndex });
      return;
    }

    queue.push({ type: 'answer', answer: lastText, citations: dedupeCitations(citations) });
    trace.end({ okChunks: stepIndex });
  }

  private async emitFallback(
    question: string,
    ctx: AgenticQaContext,
    queue: AsyncQueue<AgenticQaEvent>,
  ): Promise<void> {
    let result: QaResult;
    try {
      result = await withToolContext(this.db, this.keyProvider, ctx, () =>
        this.retrieval.answerQuestion(question),
      );
    } catch (err) {
      queue.push({ type: 'error', message: errorMessage(err) });
      return;
    }
    queue.push({ type: 'answer', answer: result.answer, citations: result.citations });
  }
}

/**
 * `Client.callTool()`'s return type is a union that also covers the legacy
 * `toolResult`-shaped compatibility result — narrower than what we actually
 * get back (we never pass a `resultSchema` override, so the SDK always
 * resolves the standard `content`-shaped result). Validates that at runtime
 * rather than casting blindly.
 */
function asMcpClientLike(client: Client): MCPClientLike {
  return {
    async callTool(params) {
      const result = await client.callTool(params);
      if (!('content' in result) || !Array.isArray(result.content)) {
        throw new Error(`unexpected MCP tool result shape for "${params.name}"`);
      }
      return result as unknown as MCPCallToolResultLike;
    },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'agentic Q&A failed';
}

/** `search_context`'s tool result content is `[{type:'text', text: JSON.stringify(ContextSource[])}]`. */
function extractSearchContextCitations(content: unknown): QaCitation[] {
  try {
    const blocks = content as { type: string; text?: string }[];
    const text = blocks.find((b) => b.type === 'text')?.text;
    if (!text) return [];
    const sources = JSON.parse(text) as { citations?: QaCitation[] }[];
    return sources.flatMap((s) => s.citations ?? []);
  } catch {
    return [];
  }
}

function dedupeCitations(citations: QaCitation[]): QaCitation[] {
  const seen = new Set<string>();
  const out: QaCitation[] = [];
  for (const c of citations) {
    const key = `${c.sourceId}\u0000${c.quote}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

/** Bridges a producer running inside `traceAgentLoop`'s scope to this generator's consumer. */
class AsyncQueue<T> {
  private readonly items: T[] = [];
  private readonly waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    while (this.waiters.length > 0)
      this.waiters.shift()!({ value: undefined as never, done: true });
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      if (result.done) return;
      yield result.value;
    }
  }
}
