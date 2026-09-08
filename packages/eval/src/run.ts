import { createProviderFromEnv, createRouter, loadLlmEnv } from '@fde/llm';

import { gate, loadBaseline, writeBaseline } from './baseline.js';
import { loadFixtures } from './fixtures.js';
import { formatReport } from './report.js';
import { runEval } from './runner.js';

/**
 * The extraction eval runner. Gated on a provider key (`LLM_API_KEY` for the dev
 * provider, or `ANTHROPIC_API_KEY`) — prints a skip notice and exits 0 without
 * one, so it is safe as a non-required CI step. Not part of `pnpm test`.
 *
 *   pnpm --filter @fde/eval eval                   # run + no-regression gate
 *   pnpm --filter @fde/eval eval -- --update-baseline   # bless a new baseline
 */
async function main(): Promise<void> {
  loadLlmEnv();
  const updateBaseline = process.argv.includes('--update-baseline');

  if (!process.env.LLM_API_KEY && !process.env.ANTHROPIC_API_KEY) {
    console.log(
      'eval: skipped — no provider key. Set LLM_API_KEY (dev provider) or ANTHROPIC_API_KEY.',
    );
    return;
  }

  const router = createRouter({ provider: createProviderFromEnv() });
  const report = await runEval({ router, fixtures: loadFixtures() });
  console.log(formatReport(report));

  if (updateBaseline) {
    const path = writeBaseline({
      promptVersion: report.promptVersion,
      model: report.model,
      seed: false,
      aggregate: report.aggregate,
      recordedAt: new Date().toISOString(),
    });
    console.log(`\neval: baseline blessed → ${path}`);
    return;
  }

  const result = gate(report.aggregate, loadBaseline(report.promptVersion));
  if (result.informational) {
    console.log(
      `\neval: no active baseline for prompt ${report.promptVersion} — run with --update-baseline to bless one.`,
    );
    return;
  }
  if (!result.ok) {
    console.error('\neval: REGRESSION vs baseline —');
    for (const r of result.regressions) {
      console.error(`  ${r.metric}: ${r.baseline.toFixed(3)} → ${r.current.toFixed(3)}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log('\neval: no regression vs baseline ✓');
}

main().catch((err: unknown) => {
  console.error(`eval: failed — ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
