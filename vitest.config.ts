import { defineConfig } from 'vitest/config';

// Vitest forwards these to Node as --conditions, so never list `import` or `module` here: that
// makes CommonJS dependencies require() ESM builds and get a namespace object back.
const conditions = ['source', 'node'];

export default defineConfig({
  resolve: { conditions },
  ssr: { resolve: { conditions } },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
