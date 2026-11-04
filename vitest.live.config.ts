import { defineConfig } from 'vitest/config';

// Live tests make real Claude Code calls and draw on the subscription.
// Haiku only, except the one check that each configured model is served as requested.
export default defineConfig({
  test: {
    include: ['src/**/test/**/*.live.test.ts'],
    passWithNoTests: true,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    fileParallelism: false,
  },
});
