import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SEVERITIES, type Config, type Severity } from './types.js';

const DEFAULTS: Omit<Config, 'apiKey'> = {
  baseRef: null,
  headRef: null,
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  maxDiffBytes: 400_000,
  minSeverity: 'nit',
  // Long enough for a near-max_tokens response on a large diff; a 2-minute cap
  // was tripping the abort controller before the model finished, not because
  // the model was stuck — the same non-transient failure retries can't fix.
  timeoutMs: 300_000,
  retries: 2,
  passes: { review: true, security: true },
  blockingSeverity: 'high',
  failOn: null,
};

export function repoRoot(): string {
  return execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

function readJsonConfig(root: string): Partial<Config> {
  try {
    const raw = readFileSync(join(root, '.fde-review.json'), 'utf8');
    return JSON.parse(raw) as Partial<Config>;
  } catch {
    return {};
  }
}

/** Block the thread for `ms` — loadConfig is sync and the retry below needs a real pause. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function loadDotEnv(root: string): void {
  const path = join(root, '.env');
  // `.env` is often a symlink onto a slower volume (shared across git worktrees);
  // a transient read failure right after heavy git I/O shouldn't lose the key.
  for (let i = 0; i < 4; i++) {
    try {
      process.loadEnvFile(path); // Node >=20.12; only sets keys not already present
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return; // genuinely absent
      sleepSync(200);
    }
  }
}

function asSeverity(value: unknown, fallback: Severity): Severity {
  return SEVERITIES.includes(value as Severity) ? (value as Severity) : fallback;
}

/** Precedence: built-in defaults < .fde-review.json < environment < CLI overrides. */
export function loadConfig(overrides: Partial<Config> = {}, root = repoRoot()): Config {
  loadDotEnv(root);
  const file = readJsonConfig(root);
  const env = process.env;

  // In CI the working tree is the PR being gated, so its committed .fde-review.json
  // must not be able to switch review passes off and coast to an approval. (The
  // other knobs can't weaken the gate: blockingSeverity only goes stricter than
  // its `high` default, minSeverity is display-only.)
  const ci = env.GITHUB_ACTIONS === 'true';

  const merged: Config = {
    baseRef: overrides.baseRef ?? env.REVIEW_BASE ?? file.baseRef ?? DEFAULTS.baseRef,
    headRef: overrides.headRef ?? env.REVIEW_HEAD ?? DEFAULTS.headRef,
    baseUrl: overrides.baseUrl ?? env.REVIEW_BASE_URL ?? file.baseUrl ?? DEFAULTS.baseUrl,
    model: overrides.model ?? env.REVIEW_MODEL ?? file.model ?? DEFAULTS.model,
    apiKey: overrides.apiKey ?? env.REVIEW_API_KEY ?? null,
    maxDiffBytes:
      overrides.maxDiffBytes ??
      numeric(env.REVIEW_MAX_DIFF_BYTES) ??
      file.maxDiffBytes ??
      DEFAULTS.maxDiffBytes,
    minSeverity: asSeverity(
      overrides.minSeverity ?? env.REVIEW_MIN_SEVERITY ?? file.minSeverity,
      DEFAULTS.minSeverity,
    ),
    timeoutMs:
      overrides.timeoutMs ?? numeric(env.REVIEW_TIMEOUT_MS) ?? file.timeoutMs ?? DEFAULTS.timeoutMs,
    retries: overrides.retries ?? numeric(env.REVIEW_RETRIES) ?? file.retries ?? DEFAULTS.retries,
    passes: ci
      ? { review: true, security: true }
      : { ...DEFAULTS.passes, ...file.passes, ...overrides.passes },
    blockingSeverity: asSeverity(
      overrides.blockingSeverity ?? env.REVIEW_BLOCKING_SEVERITY ?? file.blockingSeverity,
      DEFAULTS.blockingSeverity,
    ),
    failOn:
      overrides.failOn ??
      (env.REVIEW_FAIL_ON ? asSeverity(env.REVIEW_FAIL_ON, 'high') : null) ??
      file.failOn ??
      DEFAULTS.failOn,
  };
  return merged;
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** True when a real model call is possible (Ollama and the claude shim need no key). */
export function canCallModel(cfg: Config): boolean {
  if (cfg.apiKey) return true;
  if (cfg.model === 'claude') return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?/i.test(cfg.baseUrl);
}
