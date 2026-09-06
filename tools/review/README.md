# @fde/review

A pay-per-token **review gate** for a solo project. Two surfaces, same core
(`diff → provider → passes → Finding[]`):

- **Local `pre-push` hook** — deterministic checks (`lint`, `typecheck`,
  `format:check`, `test`) **block the push**; an AI review + security pass over
  `git diff --merge-base <base> HEAD` print findings and **never block**.
- **GitHub Action** (`--sink github`) — the same two AI passes, but findings land
  as **inline PR review comments**, get **resolved with a note on re-review** once
  fixed, and the PR is **approved when nothing is at or above `blockingSeverity`**
  (default `high`).

The AI pass runs in **one place per push**: the local hook does it until the
branch has an open PR, then it steps aside and the Action owns it (`git push`
with `AI_REVIEW_ALWAYS=1` forces the local pass anyway). The deterministic checks
run both locally (hook) and in CI (`ci.yml`).

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

| Env var           | Default                    | Notes                                                   |
| ----------------- | -------------------------- | ------------------------------------------------------- |
| `REVIEW_API_KEY`  | —                          | No key ⇒ AI review is skipped (gate still runs).        |
| `REVIEW_BASE_URL` | `https://api.deepseek.com` | Any OpenAI-compatible endpoint.                         |
| `REVIEW_MODEL`    | `deepseek-v4-flash`        | `deepseek-v4-pro`, `qwen3-coder:30b`, `claude`.         |
| `REVIEW_BASE`     | auto                       | Ref to diff against.                                    |
| `REVIEW_GH_TOKEN` | ambient `gh` auth          | github sink: token for `gh` (falls back to `GH_TOKEN`). |

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
pnpm review -- --sink github          # post to the current branch's open PR
pnpm review -- --fail-on high         # also exit non-zero on a high finding
pnpm review -- --help
```

## Escape hatches

| Command                       | Effect                                       |
| ----------------------------- | -------------------------------------------- |
| `git push --no-verify`        | skip the hook entirely                       |
| `SKIP_REVIEW_GATE=1 git push` | skip the deterministic checks                |
| `SKIP_AI_REVIEW=1 git push`   | skip the AI review                           |
| `AI_REVIEW_ALWAYS=1 git push` | run the local AI review even with an open PR |

## GitHub Action (`--sink github`)

`.github/workflows/review.yml` runs on every non-draft PR from this repo. It needs
one repo secret, `REVIEW_API_KEY` (the DeepSeek key). Each run:

1. **Reconciles comments by identity.** Every finding gets a stable key
   (`sha1(pass + file + slug(title))`, embedded as `<!-- fde-review:key=… -->`),
   so it survives line shifts and edits.
   - new finding → a new inline review comment
   - finding gone → its thread is **resolved** with a reply
     `✅ Resolved — no longer flagged as of <sha>`
   - a previously-resolved finding reappears → thread **reopened** with
     `⚠️ Reopened …`
   - finding still there → left alone
2. **Updates one summary comment** (marker `<!-- fde-review:summary -->`) in place:
   a table of open findings (🆕 vs 📌), counts of resolved/reopened, the run
   number, and the verdict.
3. **Submits a verdict — only when it changes.** No blocking finding →
   `gh pr review --approve`. A blocking finding → a `--comment` (or
   `--request-changes` with `--request-changes`). A pass that errored →
   `⚠️ review incomplete`, approval withheld. Approval by the PR author is
   impossible, so a local run as yourself falls back to an `✅` comment; in CI the
   token is `github-actions[bot]`, which can approve once
   _Settings → Actions → General → "Allow GitHub Actions to … approve pull
   requests"_ is on.

Findings the model reports outside the PR diff can't be attached to a line — they
go in a collapsed section of the summary instead.

### Trust model

The reviewer gates a PR using the PR's own diff, which is attacker-controlled
input. A few things keep the verdict meaningful:

- **The workflow runs from the base ref, not the PR head.** It checks out
  `base.sha`, fetches `head.sha` as data, and runs
  `pnpm review --base <base> --head <head>`. So `tools/review/**`, `prompts/**`,
  `.fde-review.json`, and the lockfile are all trusted — a PR can't edit its own
  reviewer or prompts. (Only same-repo, non-draft PRs run at all, since
  `REVIEW_API_KEY` is in scope.)
- **`loadConfig` ignores `.fde-review.json`'s `passes` when `GITHUB_ACTIONS=true`**
  — belt and braces; both passes always run in CI.
- **An incomplete review never approves** — if a pass errors (timeout, API
  outage), the verdict is `⚠️ incomplete`, not `✅`.
- Model output is still untrusted text: every field is run through `clean()`
  before it goes in a comment (HTML-comment delimiters defanged so a finding
  can't forge a marker; `|` escaped in cells).

**Auto-approve remains advisory** — a prompt-injection payload in a diff could
still suppress findings. The deterministic gate (`ci.yml`: lint/build/test) is the
real merge gate.

### Bot identity

The workflow uses `${{ github.token }}` → comments and the approval come from
**`github-actions[bot]`**, zero setup. That approval does **not** count toward a
"require approvals" branch-protection rule. To get a named identity and/or an
approval that counts, create a machine account, add it as a collaborator, mint a
fine-grained PAT (Pull requests: read/write), store it as `REVIEW_BOT_TOKEN`, and
the workflow picks it up automatically (`secrets.REVIEW_BOT_TOKEN || github.token`).
