import { defineConfig } from 'vitest/config';

// Root config: runs every workspace project plus the repo-level checks in test/.
// Each workspace owns its vitest.config.ts, so `yarn test` inside one also works.
export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/*',
      {
        test: {
          name: 'repo',
          environment: 'node',
          include: ['test/**/*.test.ts'],
        },
      },
    ],
  },
});
