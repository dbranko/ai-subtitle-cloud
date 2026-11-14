import { defineConfig } from '@playwright/test';

// End-to-end tests of the progress system in a real browser, against real api
// and worker processes (mock AI). Each test starts its own stack, so they run
// one at a time. Run with: pnpm test:e2e
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 20_000 },
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list']],
  use: { trace: 'off', video: 'off', screenshot: 'off' },
});
