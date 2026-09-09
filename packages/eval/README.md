# @fde/eval

The extraction eval harness — hand-labelled transcript fixtures scored against
the real `@fde/llm` router, with a no-regression gate on prompt changes.
"Extraction quality _is_ the product" (`docs/architecture.md`).

Dev-only. Not published, not a dependency of anything, **not part of `pnpm test`**
(the scorer's own unit tests _are_).

## Run it

```bash
# reuses the @fde/llm provider env — LLM_API_KEY (dev provider) or ANTHROPIC_API_KEY
pnpm --filter @fde/eval eval   # builds @fde/llm + @fde/core first, then runs
```

With no provider key it prints a skip notice and exits 0 (safe as a non-required
CI step). With one, it runs every fixture in `fixtures/` through
`router.extract(extractionResultSchema, …)` and reports:

- **precision / recall** on fact count by type (`Σ min(expected, actual)` over the
  numerator, `Σ actual` / `Σ expected` over the denominators)
- **phrase recall** — whether each expected key phrase appears in some
  `evidence.quote`

then aggregates (macro-average across fixtures) and checks the no-regression
gate.

## Fixtures

`fixtures/*.json`, one per file, hand-written — **no real customer data**:

```json
{
  "id": "datastore-decision",
  "chunk": "Priya: … commit to Postgres …\nMarcus: … migration plan ready by Friday.",
  "expected": {
    "factsByType": { "decision": 1, "commitment": 1 },
    "keyPhrases": ["commit to Postgres", "migration plan ready by Friday"]
  }
}
```

`empty-smalltalk.json` is the negative case: `{}` expected — a spurious fact
there drives precision to 0.

## The no-regression gate

A committed baseline lives at `baselines/baseline.<promptVersion>.json`, keyed by
the extraction prompt version. The runner **fails** (exit 1) if any aggregate
metric drops more than `0.05` below the baseline for the same prompt version.

A **seed** baseline (`"seed": true`, the committed default) is informational —
the gate does not fire until a real baseline is blessed:

```bash
# bless the current numbers as the baseline for this prompt version
pnpm --filter @fde/eval eval -- --update-baseline
```

Do this when a prompt change in `packages/llm/src/prompts.ts` is a **deliberate
improvement** — run the eval against the production provider (`claude-sonnet-5`,
the bulk tier), eyeball the report, then `--update-baseline` and commit the new
`baselines/baseline.<newVersion>.json` alongside the prompt change.

## CI

`.github/workflows/eval.yml` runs this when `packages/llm/src/prompts.ts` or
`packages/eval/**` changes. It is **not a required check**: CI has no ZDR
provider, so without `EVAL_LLM_*` repo secrets the job prints the skip notice and
passes. Treat a prompt change as gated by a **manual** eval run against the
production provider until a CI-side provider is wired up.

A local run against the dev provider (DeepSeek `deepseek-v4-flash`) lands around
P 87% / R 100% / phrases 100% — useful as a sanity check, not a baseline (the
baseline should reflect the production model).
