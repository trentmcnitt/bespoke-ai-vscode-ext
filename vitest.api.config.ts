import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/test/api/shared-scenarios.test.ts',
      'src/test/api/content-validation.test.ts',
      'src/test/api/claude-code.test.ts',
      'src/test/api/anchor-echo.test.ts',
      'src/test/api/slot-endurance.test.ts',
      'src/test/api/api-adapters.test.ts',
    ],
    testTimeout: 30000,
    globals: true,
  },
});
