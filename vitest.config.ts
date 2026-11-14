import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) =>
  fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Resolve workspace packages to their TypeScript sources so tests never need a prior build.
    alias: {
      '@asc/shared': src('shared'),
      '@asc/config': src('config'),
      '@asc/database': src('database'),
      '@asc/subtitle-parser': src('subtitle-parser'),
      '@asc/ai-providers': src('ai-providers'),
      '@asc/translation-engine': src('translation-engine'),
      '@asc/subtitle-sources': src('subtitle-sources'),
      '@asc/jobs': src('jobs'),
    },
  },
  test: {
    include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    environment: 'node',
    globalSetup: ['./vitest.global-setup.ts'],
    testTimeout: 15_000,
  },
});
