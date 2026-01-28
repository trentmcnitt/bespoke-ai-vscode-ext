import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test/quality/**/*.test.ts'],
    testTimeout: 60000, // 60s — each test makes a live API call to generate a completion
    globals: true,
  },
});
