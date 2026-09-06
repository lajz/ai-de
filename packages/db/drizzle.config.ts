import { defineConfig } from 'drizzle-kit';

// Points at the *built* schema: `pnpm build` first. drizzle-kit 0.30's bundler
// does not resolve NodeNext `.js` specifiers against `.ts` sources, but the
// compiled `dist/` resolves cleanly (and `@fde/core` is already built too).
export default defineConfig({
  schema: './dist/schema/index.js',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL ?? '' },
  strict: true,
  verbose: true,
});
