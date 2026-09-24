import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import type { EngagementId, TenantId, UserId } from '@fde/core';
import { FakeKeyProvider } from '@fde/crypto';
import type { Database } from '@fde/db';
import {
  FakeTracer,
  type AgentLoopEvent,
  type AgentLoopRequest,
  type ChatMessage,
  type Router,
  type UsageRecord,
} from '@fde/llm';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { LineageService } from '../lineage/lineage.service.js';
import { AgenticQaService, MAX_HISTORY_MESSAGES, MAX_TOOL_CALLS } from './agentic-qa.service.js';
import type { ContextSource, QaResult } from './retrieval.service.js';
import { RetrievalService } from './retrieval.service.js';

const tenantId = randomUUID() as TenantId;
const userId = randomUUID() as UserId;
const engagementId = randomUUID() as EngagementId;
const ctx = { tenantId, userId, engagementId };

const USAGE: UsageRecord = {
  provider: 'anthropic',
  model: 'claude-opus-5',
  tier: 'default',
  promptVersion: '2026-09-23',
  inputTokens: 100,
  outputTokens: 20,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  costUsd: 0.001,
  pricedFrom: 'claude-opus-5',
  latencyMs: 10,
};

interface Chain {
  select: () => Chain;
  from: () => Chain;
  innerJoin: () => Chain;
  where: () => Chain;
  limit: () => Chain;
  for: () => Chain;
  then: <R>(onOk: (v: unknown[]) => R, onErr?: (e: unknown) => R) => Promise<R>;
}

function chain(rows: unknown[]): Chain {
  const c: Chain = {
    select: () => c,
    from: () => c,
    innerJoin: () => c,
    where: () => c,
    limit: () => c,
    for: () => c,
    then: (onOk, onErr) => Promise.resolve(rows).then(onOk, onErr),
  };
  return c;
}

/** A `withEngagement`-shaped fake DB — real `withEngagement`/`withTenant` run against it (no Postgres). */
function fakeDb(wrappedDekB64: string): Database {
  const tx = {
    execute: () => Promise.resolve([]),
    select: () =>
      chain([
        { status: 'active', wrappedDek: wrappedDekB64, byokKeyArn: null, tenantCmkArn: 'fake:cmk' },
      ]),
    insert: () => ({ values: () => Promise.resolve(undefined) }),
  };
  return { transaction: (cb: (tx: unknown) => Promise<unknown>) => cb(tx) } as unknown as Database;
}

function fakeRouter(runAgentLoop: (r: AgentLoopRequest) => AsyncGenerator<AgentLoopEvent>): Router {
  return {
    provider: { name: 'fake', zeroDataRetention: true } as never,
    zeroDataRetention: true,
    assertZeroDataRetention: () => {},
    complete: vi.fn(),
    extract: vi.fn(),
    runAgentLoop,
  } as unknown as Router;
}

async function* events(seq: AgentLoopEvent[]): AsyncGenerator<AgentLoopEvent> {
  for (const e of seq) yield e;
}

async function drain(gen: AsyncGenerator<unknown>): Promise<unknown[]> {
  const out: unknown[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

describe('AgenticQaService.ask', () => {
  let db: Database;
  const provider = new FakeKeyProvider();

  beforeAll(async () => {
    const { wrappedDek } = await provider.generateDek({
      tenantId,
      engagementId,
      tenantCmkArn: 'fake:cmk',
    });
    db = fakeDb(Buffer.from(wrappedDek).toString('base64'));
  });

  it('streams tool_step events, then the final answer with citations harvested from search_context', async () => {
    const contextSources: ContextSource[] = [
      {
        sourceId: 's1',
        permalink: 'https://ex.com/1',
        factSummaries: ['fact'],
        quotes: ['q1'],
        citations: [{ sourceId: 's1', permalink: 'https://ex.com/1', quote: 'q1' }],
      },
    ];

    const router = fakeRouter(() =>
      events([
        { type: 'tool_call', name: 'search_context', input: { query: 'x' } },
        { type: 'usage', usage: USAGE },
        {
          type: 'tool_result',
          name: 'search_context',
          isError: false,
          content: [{ type: 'text', text: JSON.stringify(contextSources) }],
        },
        { type: 'text', text: 'We chose Postgres (https://ex.com/1)' },
        { type: 'usage', usage: USAGE },
      ]),
    );

    const tracer = new FakeTracer();
    const retrieval = {
      searchContext: vi.fn(),
      answerQuestion: vi.fn(),
    } as unknown as RetrievalService;
    const lineage = {} as unknown as LineageService;
    const svc = new AgenticQaService(retrieval, lineage, db, provider, router, tracer);

    const result = await drain(svc.ask('what db?', ctx));

    expect(result).toEqual([
      { type: 'tool_step', tool: 'search_context', status: 'started' },
      { type: 'tool_step', tool: 'search_context', status: 'ok' },
      {
        type: 'answer',
        answer: 'We chose Postgres (https://ex.com/1)',
        citations: [{ sourceId: 's1', permalink: 'https://ex.com/1', quote: 'q1' }],
      },
    ]);
    expect(retrieval.answerQuestion).not.toHaveBeenCalled();

    // Langfuse gets one trace, one generation per LLM turn — never the answer text itself.
    expect(tracer.traces).toHaveLength(1);
    expect(tracer.traces[0]!.input).toMatchObject({ name: 'qa.agentic', engagementId });
    expect(tracer.traces[0]!.generations).toHaveLength(2);
    expect(tracer.traces[0]!.generations[0]).toMatchObject({
      toolName: 'search_context',
      stepIndex: 0,
    });
    expect(JSON.stringify(tracer.traces)).not.toContain('Postgres');
  });

  it('threads prior history onto the new question as one messages array', async () => {
    let seen: AgentLoopRequest | undefined;
    const router = fakeRouter((r) => {
      seen = r;
      return events([
        { type: 'text', text: 'ok' },
        { type: 'usage', usage: USAGE },
      ]);
    });
    const tracer = new FakeTracer();
    const retrieval = { answerQuestion: vi.fn() } as unknown as RetrievalService;
    const lineage = {} as unknown as LineageService;
    const svc = new AgenticQaService(retrieval, lineage, db, provider, router, tracer);

    const history: ChatMessage[] = [
      { role: 'user', content: 'what db did we pick?' },
      { role: 'assistant', content: 'Postgres.' },
    ];
    await drain(svc.ask('why not DynamoDB?', ctx, history));

    expect(seen?.messages).toEqual([...history, { role: 'user', content: 'why not DynamoDB?' }]);
  });

  it('bounds history to MAX_HISTORY_MESSAGES, keeping the most recent turns', async () => {
    let seen: AgentLoopRequest | undefined;
    const router = fakeRouter((r) => {
      seen = r;
      return events([
        { type: 'text', text: 'ok' },
        { type: 'usage', usage: USAGE },
      ]);
    });
    const tracer = new FakeTracer();
    const retrieval = { answerQuestion: vi.fn() } as unknown as RetrievalService;
    const lineage = {} as unknown as LineageService;
    const svc = new AgenticQaService(retrieval, lineage, db, provider, router, tracer);

    const longHistory: ChatMessage[] = Array.from({ length: MAX_HISTORY_MESSAGES + 5 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `turn ${i}`,
    }));
    await drain(svc.ask('latest question', ctx, longHistory));

    const messages = seen?.messages as ChatMessage[];
    expect(messages).toHaveLength(MAX_HISTORY_MESSAGES + 1); // trimmed history + the new question
    expect(messages[0]).toEqual(longHistory.at(-MAX_HISTORY_MESSAGES)); // oldest kept turn
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'latest question' });
  });

  it('falls back to the one-shot answerQuestion when the loop exceeds MAX_TOOL_CALLS', async () => {
    const manyToolCalls: AgentLoopEvent[] = [];
    for (let i = 0; i <= MAX_TOOL_CALLS; i++) {
      manyToolCalls.push({ type: 'tool_call', name: 'search_context', input: {} });
      manyToolCalls.push({ type: 'usage', usage: USAGE });
    }
    const router = fakeRouter(() => events(manyToolCalls));

    const tracer = new FakeTracer();
    const fallback: QaResult = { answer: 'fallback answer', citations: [] };
    const retrieval = {
      answerQuestion: vi.fn(async () => fallback),
    } as unknown as RetrievalService;
    const lineage = {} as unknown as LineageService;
    const svc = new AgenticQaService(retrieval, lineage, db, provider, router, tracer);

    const result = await drain(svc.ask('what db?', ctx));

    expect(result.at(-1)).toEqual({ type: 'answer', answer: 'fallback answer', citations: [] });
    expect(retrieval.answerQuestion).toHaveBeenCalledWith('what db?');
  });

  it('falls back to the one-shot path when the agent loop throws', async () => {
    async function* throwing(): AsyncGenerator<AgentLoopEvent> {
      yield { type: 'tool_call', name: 'search_context', input: {} };
      throw new Error('tool runner blew up');
    }
    const router = fakeRouter(throwing);
    const tracer = new FakeTracer();
    const fallback: QaResult = { answer: 'fallback answer', citations: [] };
    const retrieval = {
      answerQuestion: vi.fn(async () => fallback),
    } as unknown as RetrievalService;
    const lineage = {} as unknown as LineageService;
    const svc = new AgenticQaService(retrieval, lineage, db, provider, router, tracer);

    const result = await drain(svc.ask('what db?', ctx));

    expect(result.at(-1)).toEqual({ type: 'answer', answer: 'fallback answer', citations: [] });
  });

  it('emits an error event when even the fallback fails', async () => {
    // eslint-disable-next-line require-yield -- deliberately throws before any tool call
    async function* throwing(): AsyncGenerator<AgentLoopEvent> {
      throw new Error('tool runner blew up');
    }
    const router = fakeRouter(throwing);
    const tracer = new FakeTracer();
    const retrieval = {
      answerQuestion: vi.fn(async () => {
        throw new Error('fallback also failed');
      }),
    } as unknown as RetrievalService;
    const lineage = {} as unknown as LineageService;
    const svc = new AgenticQaService(retrieval, lineage, db, provider, router, tracer);

    const result = await drain(svc.ask('what db?', ctx));

    expect(result).toEqual([{ type: 'error', message: 'fallback also failed' }]);
  });
});
