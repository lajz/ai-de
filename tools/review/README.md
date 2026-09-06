# @fde/review

A local, pay-per-token **pre-merge review gate** for a solo project. It runs from
the `pre-push` git hook and has two parts:

1. **Deterministic checks** — `lint`, `typecheck`, `format:check`, `test`. These
   **block the push** if they fail. (Just the existing root scripts.)
2. **Advisory AI review** — a general code-review pass and a security pass over
   `git diff --merge-base <base> HEAD`. Prints findings grouped by severity;
   **never blocks**.

## Setup

```bash
# 1. one-time: install the hook (also runs automatically on `pnpm install`)
pnpm install                       # fires "prepare" -> git config core.hooksPath .githooks

# 2. add a model key so the AI pass runs (optional — checks work without it)
cp .env.example .env
#   set REVIEW_API_KEY=... from https://platform.deepseek.com
```

That's it. `git push` now runs the gate.

## Model

Config precedence: built-in defaults < `.fde-review.json` (committed) < environment
/ `.env` < CLI flags. The **key only ever comes from the environment**.

| Env var           | Default                    | Notes                                            |
| ----------------- | -------------------------- | ------------------------------------------------ |
| `REVIEW_API_KEY`  | —                          | No key ⇒ AI review is skipped (gate still runs). |
| `REVIEW_BASE_URL` | `https://api.deepseek.com` | Any OpenAI-compatible endpoint.                  |
| `REVIEW_MODEL`    | `deepseek-v4-flash`        | `deepseek-v4-pro`, `qwen3-coder:30b`, `claude`.  |
| `REVIEW_BASE`     | auto                       | Ref to diff against.                             |

- **DeepSeek V4 Flash** (default): ~1–2¢ per review; ~half that during off-peak
  hours (01:00–04:00 & 06:00–10:00 UTC).
- **Ollama**: `REVIEW_BASE_URL=http://localhost:11434/v1 REVIEW_MODEL=qwen3-coder:30b` —
  no key, no network cost.
- **`REVIEW_MODEL=claude`**: shells out to the Claude CLI (uses your existing
  subscription).

## Running it directly

```bash
pnpm review                          # same as the hook's advisory pass
pnpm review -- --base origin/main --min medium
pnpm review -- --security-only
pnpm review -- --help
```

## Escape hatches

| Command                       | Effect                        |
| ----------------------------- | ----------------------------- |
| `git push --no-verify`        | skip the hook entirely        |
| `SKIP_REVIEW_GATE=1 git push` | skip the deterministic checks |
| `SKIP_AI_REVIEW=1 git push`   | skip the AI review            |

## Later: GitHub Action

The core (`diff.ts` → `provider.ts` → `passes.ts` → `Finding[]`) is
environment-agnostic. To run it on `pull_request`, add `src/github.ts` (a `Sink`
that posts findings as review comments), a `--sink github` branch in `cli.ts`, and
a workflow that passes `--base ${{ github.event.pull_request.base.sha }}` with the
DeepSeek key as a repo secret. Nothing else changes.
