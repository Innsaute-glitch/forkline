import { defineConfig } from 'vitest/config';

// One glob: new tasks' tests are picked up without editing this file.
// Live tests (real Claude Code calls) are excluded; see vitest.live.config.ts.
export default defineConfig({
  test: {
    include: ['src/**/test/**/*.test.ts'],
    exclude: ['src/**/test/**/*.live.test.ts', 'node_modules/**', 'dist/**'],
    passWithNoTests: false,
  },
});
