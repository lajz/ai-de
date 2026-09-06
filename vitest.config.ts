import { defineConfig } from 'vitest/config';

// Tests run against package *source* (not built dist), so the suite needs no
// prior build step.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts', 'tools/*/src/**/*.test.ts'],
    environment: 'node',
  },
});
