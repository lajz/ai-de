# @fde/llm

Claude router + versioned prompts + pluggable embedding client. The
standalone-package half of ROADMAP #8 — the `ExtractionPipeline` Temporal
workflow (which _calls_ this) is a separate PR.

## Router

```ts
import { createRouter } from '@fde/llm';

const router = createRouter({ onUsage: (rec) => langfuse.record(rec) });

// Free text
const { text, usage } = await router.complete({
  tier: 'bulk', // 'default' → opus-5, 'bulk' → sonnet-5
  prompt: { name: 'extraction' }, // registry prompt → system + promptVersion
  messages: wrapTranscript(chunk),
});

// Structured output, validated against a Zod schema
const { value } = await router.extract(extractionResultSchema, {
  tier: 'bulk',
  prompt: { name: 'extraction' },
  messages: wrapTranscript(chunk),
  jsonSchema: extractionJsonSchema,
  schemaName: 'record_extraction',
});
```

Every call returns a `UsageRecord` — `{ provider, model, tier, promptVersion,
inputTokens, outputTokens, cache*, costUsd, pricedFrom, latencyMs }` — and
forwards it to `onUsage`. **It never contains prompt or response text**
(`docs/architecture.md`: the router logs `{model, prompt_version, tokens, cost}`
and never content). Langfuse wiring is #11; this is the seam.

## Providers

Selected by `LLM_PROVIDER` (default `anthropic`):

| `LLM_PROVIDER`      | Class                      | ZDR | Use                                                                                       |
| ------------------- | -------------------------- | --- | ----------------------------------------------------------------------------------------- |
| `anthropic`         | `AnthropicProvider`        | ✅  | **Production.** Claude + Zero Data Retention. The only provider for regulated content.    |
| `openai-compatible` | `OpenAiCompatibleProvider` | ❌  | **Dev / CI only.** DeepSeek, Ollama — any `/chat/completions` endpoint. No ZDR guarantee. |

`AnthropicProvider` enforces ZDR at construction: `zeroDataRetention: false` is
only permitted together with a non-Anthropic `baseURL` (Bedrock, a ZDR proxy) —
swapping to Bedrock later is a config change. `router.assertZeroDataRetention()`
throws for a non-ZDR provider; the extraction workflow calls it for regulated
engagements.

`OpenAiCompatibleProvider` prints a `console.warn` on construction and reports
`zeroDataRetention: false`. **Do not point it at a regulated engagement's
content.**

### Running against DeepSeek (dev)

Add to the worktree `.env` (gitignored, per-worktree):

```
LLM_PROVIDER=openai-compatible
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=sk-...
LLM_MODEL=deepseek-v4-flash
```

`pnpm test` then runs `live.smoke.test.ts` against it (it `skipIf`s without
`LLM_API_KEY`).

## Prompts

Versioned, file-backed. `getPrompt(name, version?)` → `{ system, version }`;
without a version it returns the highest-sorting (latest). Seeded prompt:
`extraction` (decision / commitment / risk / question / action-item /
status-change). Source text is treated as **data, never instructions** — see
`wrapTranscript()` and the injection-posture note in the prompt.

## Embeddings

`EmbeddingClient` — `{ embed(texts): Promise<number[][]>; dim; model }`,
`EMBEDDING_DIM = 1024` (must match `@fde/db`).

- `FakeEmbeddingClient` — deterministic, dependency-free, for tests.
- `VoyageEmbeddingClient` — Voyage AI (`voyage-3.5`, dim 1024), behind the same
  interface. A self-hosted BGE/E5 client drops in here for regulated / T1 (M4).

## Cost table

`MODEL_RATES` / `EMBEDDING_RATES` in `pricing.ts` — the one place to edit rates.
Anthropic rates are first-party list price; DeepSeek rates are estimates for the
dev provider (confirm at platform.deepseek.com/pricing).
