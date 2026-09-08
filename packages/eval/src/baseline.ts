import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import type { Aggregate } from './scorer.js';

export const baselineSchema = z.object({
  promptVersion: z.string(),
  model: z.string(),
  /** a seed baseline has no live numbers yet — the gate treats it as informational */
  seed: z.boolean().default(false),
  aggregate: z.object({
    precision: z.number(),
    recall: z.number(),
    phraseRecall: z.number(),
  }),
  recordedAt: z.string(),
});
export type Baseline = z.infer<typeof baselineSchema>;

const BASELINES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'baselines');

export function baselinePath(promptVersion: string, dir = BASELINES_DIR): string {
  return join(dir, `baseline.${promptVersion}.json`);
}

export function loadBaseline(promptVersion: string, dir = BASELINES_DIR): Baseline | null {
  const path = baselinePath(promptVersion, dir);
  if (!existsSync(path)) return null;
  return baselineSchema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export function writeBaseline(baseline: Baseline, dir = BASELINES_DIR): string {
  mkdirSync(dir, { recursive: true });
  const path = baselinePath(baseline.promptVersion, dir);
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
  return path;
}

export interface GateResult {
  ok: boolean;
  /** true ⇒ no comparison was made (no baseline, or a seed baseline) */
  informational: boolean;
  regressions: { metric: keyof Aggregate; baseline: number; current: number }[];
}

/**
 * Fail if any aggregate metric fell more than `epsilon` below the baseline for
 * the same prompt version. A missing or seed baseline is informational, never a
 * failure — bless one with `--update-baseline`.
 */
export function gate(current: Aggregate, baseline: Baseline | null, epsilon = 0.05): GateResult {
  if (!baseline || baseline.seed) return { ok: true, informational: true, regressions: [] };
  const regressions: GateResult['regressions'] = [];
  for (const metric of ['precision', 'recall', 'phraseRecall'] as const) {
    if (current[metric] < baseline.aggregate[metric] - epsilon) {
      regressions.push({ metric, baseline: baseline.aggregate[metric], current: current[metric] });
    }
  }
  return { ok: regressions.length === 0, informational: false, regressions };
}
