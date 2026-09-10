import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

// Its own vitest project — the M1 e2e is NOT part of `pnpm test`. It needs the
// compose stack (`docker-compose.e2e.yml`) and runs serially. Package sources
// are aliased the same way the root `vitest.config.ts` does, so no build step.
const fromHere = (p: string) => resolve(import.meta.dirname, p);

export default defineConfig({
  resolve: {
    alias: {
      '@fde/connectors': fromHere('../packages/connectors/src/index.ts'),
      '@fde/core': fromHere('../packages/core/src/index.ts'),
      '@fde/crypto': fromHere('../packages/crypto/src/index.ts'),
      '@fde/db': fromHere('../packages/db/src/index.ts'),
      '@fde/identity': fromHere('../packages/identity/src/index.ts'),
      '@fde/llm': fromHere('../packages/llm/src/index.ts'),
      '@fde/workers': fromHere('../apps/workers/src'),
    },
  },
  test: {
    include: ['**/*.e2e.test.ts'],
    environment: 'node',
    // one meeting through a real Temporal dev server + a workflow-bundle build
    hookTimeout: 180_000,
    testTimeout: 180_000,
    // shared Postgres rows + one worker — never run these files in parallel
    fileParallelism: false,
  },
});
