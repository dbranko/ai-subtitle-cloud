import { defineConfig } from 'vitest/config';
import base from './vitest.config';

// Manually triggered tests that call the REAL AI providers and cost real money
// (a few cents). Never part of `pnpm test` or CI. Run with: pnpm test:live
export default defineConfig({
  ...base,
  test: {
    ...base.test,
    // Replaces (not extends) the ordinary test list: only *.live.ts files run here.
    include: ['packages/*/src/**/*.live.ts'],
    testTimeout: 300_000,
    fileParallelism: false,
  },
});
