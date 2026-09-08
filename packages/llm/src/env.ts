import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { AnthropicProvider } from './anthropic.js';
import { LlmError } from './errors.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import type { LlmProvider } from './provider.js';

export type ProviderKind = 'anthropic' | 'openai-compatible';

/**
 * Load the repo-root `.env` into `process.env` (keys not already set). Loads the
 * whole file, like `tools/review`'s `loadDotEnv` — it's a local dev/CI
 * convenience, not part of any deployed path (containers get their env injected).
 * In Orca worktrees `.env` is a per-worktree symlink onto a shared volume that
 * can momentarily EIO — retry a transient read a few times.
 *
 * No-ops under `NODE_ENV=production`: a deployed process must take its
 * environment only from what the platform injects, never from a file that
 * happens to be on disk.
 */
export function loadLlmEnv(root = repoRoot()): void {
  if (process.env.NODE_ENV === 'production') return;
  if (!root) return;
  const path = join(root, '.env');
  // Immediate retries only — this is a synchronous startup helper (called from
  // the sync `createProviderFromEnv`), so it must not park the thread with a
  // timed `Atomics.wait`. A transient shared-volume read error clears on the
  // next attempt; anything that survives 4 tries gets the warning below.
  for (let i = 0; i < 4; i++) {
    try {
      process.loadEnvFile(path); // Node >=20.12; only sets keys not already present
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // genuinely absent
      if (i === 3) {
        // Exists but unreadable — surface it (path only, never contents) rather
        // than running silently on a stale environment.
        console.warn(`@fde/llm: could not read ${path}: ${(err as Error).message}`);
        return;
      }
    }
  }
}

function repoRoot(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

/**
 * Build the provider from the environment.
 *
 * - `LLM_PROVIDER=anthropic` (default) → `AnthropicProvider` (`ANTHROPIC_API_KEY`,
 *   optional `ANTHROPIC_BASE_URL`).
 * - `LLM_PROVIDER=openai-compatible` → `OpenAiCompatibleProvider` (`LLM_BASE_URL`,
 *   `LLM_API_KEY`, `LLM_MODEL`, optional `LLM_BULK_MODEL`).
 */
export function createProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider {
  loadLlmEnv();
  const kind = (env.LLM_PROVIDER ?? 'anthropic') as ProviderKind;

  if (kind === 'anthropic') {
    return new AnthropicProvider({
      apiKey: env.ANTHROPIC_API_KEY,
      baseURL: env.ANTHROPIC_BASE_URL,
    });
  }
  if (kind === 'openai-compatible') {
    const baseUrl = env.LLM_BASE_URL;
    const model = env.LLM_MODEL;
    if (!baseUrl || !model) {
      throw new LlmError('LLM_PROVIDER=openai-compatible requires LLM_BASE_URL and LLM_MODEL');
    }
    return new OpenAiCompatibleProvider({
      baseUrl,
      model,
      apiKey: env.LLM_API_KEY,
      bulkModel: env.LLM_BULK_MODEL,
    });
  }
  throw new LlmError(`unknown LLM_PROVIDER "${kind}"`);
}
