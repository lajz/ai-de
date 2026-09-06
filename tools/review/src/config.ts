import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { SEVERITIES, type Config, type Severity } from './types.js';

const DEFAULTS: Omit<Config, 'apiKey'> = {
  baseRef: null,
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
  maxDiffBytes: 400_000,
  minSeverity: 'nit',
  timeoutMs: 90_000,
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

function loadDotEnv(root: string): void {
  try {
    // Node >=20.12: populates process.env for keys it does not already have.
    process.loadEnvFile(join(root, '.env'));
  } catch {
    /* no .env — fine */
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

  const merged: Config = {
    baseRef: overrides.baseRef ?? env.REVIEW_BASE ?? file.baseRef ?? DEFAULTS.baseRef,
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
    passes: { ...DEFAULTS.passes, ...file.passes, ...overrides.passes },
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
