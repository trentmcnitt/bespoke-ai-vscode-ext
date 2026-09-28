import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test/unit/**/*.test.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/test/**', 'src/scripts/**', 'src/**/*.d.ts', 'src/**/index.ts'],
      reporter: ['text-summary', 'text', 'json-summary', 'html'],
      reportsDirectory: 'coverage',
    },
  },
});
