import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Tests run against package *source* (not built dist) via these aliases, so the
// suite needs no prior build step.
const pkg = (name: string) => resolve(import.meta.dirname, `packages/${name}/src/index.ts`);

export default defineConfig({
  // `apps/web` ships .tsx components; automatic JSX runtime keeps its tests from
  // needing a `import React` in every file.
  esbuild: { jsx: 'automatic' },
  resolve: {
    alias: {
      '@fde/core': pkg('core'),
      '@fde/crypto': pkg('crypto'),
      '@fde/db': pkg('db'),
      '@fde/audit': pkg('audit'),
      '@fde/connectors': pkg('connectors'),
      '@fde/authz': pkg('authz'),
      '@fde/llm': pkg('llm'),
    },
  },
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'tools/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.tsx',
    ],
    environment: 'node',
  },
});
