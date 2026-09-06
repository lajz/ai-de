import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests run against package *source* (not built dist) via these aliases, so the
// suite needs no prior build step.
const pkg = (name: string) => resolve(import.meta.dirname, `packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    alias: {
      '@fde/core': pkg('core'),
      '@fde/crypto': pkg('crypto'),
      '@fde/db': pkg('db'),
      '@fde/audit': pkg('audit'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tools/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    environment: 'node',
  },
});
