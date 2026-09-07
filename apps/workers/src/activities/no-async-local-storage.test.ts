import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const activitiesDir = dirname(fileURLToPath(import.meta.url));

/** Recursively lists `.ts` source files (never `.test.ts`) under `dir`, so a future activity in a subdirectory is still covered. */
function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) return [full];
    return [];
  });
}

/**
 * The crypto-boundary convention (see `engagement-context.ts`): activities
 * take a cipher as an explicit argument, never off `AsyncLocalStorage`.
 * `withEngagementActivity` itself touches `tryGetCryptoContext` once, in a
 * documented, safe way — everything else under `activities/` (including
 * subdirectories) must not.
 */
describe('crypto-boundary convention', () => {
  const exempt = join(activitiesDir, 'engagement-context.ts');
  const files = listSourceFiles(activitiesDir).filter((f) => f !== exempt);

  it.each(files.map((f) => [relative(activitiesDir, f), f] as const))(
    '%s does not reach for AsyncLocalStorage or getCipher',
    (_relativePath, file) => {
      const src = readFileSync(file, 'utf8');
      expect(src).not.toMatch(/AsyncLocalStorage/);
      expect(src).not.toMatch(/\bgetCipher\b/);
    },
  );

  it('found at least one activity file to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it('is not itself silently checking zero files due to a path typo', () => {
    expect(files.map((f) => relative(activitiesDir, f))).toContain('ping.ts');
  });
});
