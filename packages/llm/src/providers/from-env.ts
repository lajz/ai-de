import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { LlmError } from '../errors.js';
import { AnthropicProvider } from './anthropic.js';
import { OpenAiCompatibleProvider } from './openai-compatible.js';
import type { LlmProvider } from './types.js';

export type ProviderKind = 'anthropic' | 'openai-compatible';

/**
 * Load the repo-root `.env` into `process.env` (keys not already set). In Orca
 * worktrees `.env` is a per-worktree symlink onto a shared, sometimes-slow
 * volume — retry a transient read the way `tools/review` does.
 */
export function loadLlmEnv(root = repoRoot()): void {
  if (!root) return;
  const path = join(root, '.env');
  for (let i = 0; i < 4; i++) {
    try {
      process.loadEnvFile(path); // Node >=20.12; only sets keys not already present
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // genuinely absent
      if (i === 3) {
        // Exists but unreadable after retries — surface the misconfig (path only,
        // never contents) rather than silently running with a stale environment.
        console.warn(
          `@fde/llm: could not read ${path} after 4 attempts: ${(err as Error).message}`,
        );
        return;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
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
 * - `LLM_PROVIDER=openai-compatible` → `OpenAiCompatibleProvider`
 *   (`LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, optional `LLM_BULK_MODEL`).
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
      throw new LlmError(
        'LLM_PROVIDER=openai-compatible requires LLM_BASE_URL and LLM_MODEL (and usually LLM_API_KEY)',
      );
    }
    return new OpenAiCompatibleProvider({
      baseUrl,
      model,
      apiKey: env.LLM_API_KEY,
      bulkModel: env.LLM_BULK_MODEL,
    });
  }

  throw new LlmError(
    `unknown LLM_PROVIDER "${kind}" (expected "anthropic" or "openai-compatible")`,
  );
}
