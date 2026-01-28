import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test/api/**/*.test.ts'],
    testTimeout: 30000,
    globals: true,
  },
});
