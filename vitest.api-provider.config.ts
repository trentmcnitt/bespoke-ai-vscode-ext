import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test/api/api-provider.test.ts'],
    testTimeout: 30_000,
    globals: true,
    sequence: { concurrent: false },
  },
});
