# FDE Context Platform

A multi-tenant context layer for Forward Deployed Engineering organizations. It
ingests signal from meeting agents, docs, project trackers, and Slack — plus
meetings it captures itself — and builds a queryable graph of **stakeholders ↔
decisions ↔ commitments ↔ risks ↔ work items**, each record carrying
source-attributed evidence.

Architecture plan: `~/.claude/plans/linked-popping-rose.md`.

> The `@fde/*` package scope is a placeholder — rename once the product is named.

## Prerequisites

- Node `>=22` (`.nvmrc` pins 22)
- pnpm 11 (`corepack enable`)

## Setup

```bash
pnpm install
cp .env.example .env
```

## Common tasks

| Command          | What                                  |
| ---------------- | ------------------------------------- |
| `pnpm build`     | `tsc -b` across the workspace         |
| `pnpm typecheck` | `tsc -b`                              |
| `pnpm test`      | Vitest                                |
| `pnpm lint`      | ESLint (flat config)                  |
| `pnpm format`    | Prettier write                        |
| `pnpm review`    | Advisory AI review of the branch diff |

## Review gate

- **Local:** `pnpm install` installs a `pre-push` hook (`.githooks/pre-push`) that
  blocks the push on `lint` / `typecheck` / `format:check` / `test` failures, then
  runs an advisory AI review (checks block; the AI review never does).
- **PRs:** `.github/workflows/review.yml` posts the AI findings as inline review
  comments, resolves them with a note once fixed, and approves when nothing is at
  or above `high`. Needs the `REVIEW_API_KEY` repo secret.

Add a `REVIEW_API_KEY` to `.env` to enable the local AI pass — see
[`tools/review/README.md`](tools/review/README.md).
