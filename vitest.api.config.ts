import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/test/api/claude-code.test.ts',
      'src/test/api/anchor-echo.test.ts',
      'src/test/api/slot-endurance.test.ts',
      'src/test/api/api-provider.test.ts',
    ],
    testTimeout: 30000,
    globals: true,
  },
});
