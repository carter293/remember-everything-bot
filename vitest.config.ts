import { defineConfig } from 'vitest/config';

// `*.db.test.ts` needs a real DATABASE_URL, so it runs only through `pnpm test:db`.
export default defineConfig({
  test: { exclude: ['node_modules/**', ...(process.env.DB_TESTS ? [] : ['**/*.db.test.ts'])] },
});
