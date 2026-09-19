#!/usr/bin/env tsx
/**
 * Seed a demo engagement end to end: real Granola + Linear ingestion, real
 * LLM extraction, real cross-connector decision-marker resolution — a
 * repeatable, presentable dataset instead of an empty dev stack.
 *
 * Usage (from `apps/workers`, or via the root `pnpm seed:demo` delegation):
 *
 *   pnpm seed:demo -- --list                  list every registered demo
 *   pnpm seed:demo -- <slug>                  seed it (no-op if it already exists)
 *   pnpm seed:demo -- <slug> --reset          delete + fully rebuild it
 *
 * Requires: the local stack up (`pnpm dev`) and a real `apps/workers`
 * Temporal worker already running (extraction waits on it). See
 * `lib/orchestrate.ts` for the full sequence.
 *
 * Adding a new demo does not touch this file — see `demos/index.ts`.
 */
import { DEMOS } from './demos/index.js';
import { orchestrate } from './lib/orchestrate.js';

function listDemos(): void {
  console.log('registered demos:');
  for (const [slug, def] of Object.entries(DEMOS)) {
    console.log(`  ${slug} — "${def.endCustomerName}"`);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    listDemos();
    return;
  }

  const reset = args.includes('--reset');
  const slug = args.find((a) => !a.startsWith('--'));

  if (!slug) {
    console.error('usage: seed-demo.ts <slug> [--reset]   (or: seed-demo.ts --list)');
    process.exitCode = 1;
    return;
  }

  const definition = DEMOS[slug];
  if (!definition) {
    console.error(`unknown demo '${slug}' — registered: ${Object.keys(DEMOS).join(', ')}`);
    process.exitCode = 1;
    return;
  }

  await orchestrate(definition, { reset });
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`seed-demo failed: ${message}`);
  process.exitCode = 1;
});
