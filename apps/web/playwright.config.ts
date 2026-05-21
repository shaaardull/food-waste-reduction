import { defineConfig, devices } from '@playwright/test';

/**
 * Smoke tests against the diner PWA (CLAUDE.md §11: deploy-staging job
 * runs Playwright against the staged build).
 *
 * Locally:
 *   pnpm --filter @plate-clean/web test:e2e:install
 *   pnpm --filter @plate-clean/web build
 *   pnpm --filter @plate-clean/web test:e2e
 *
 * The webServer below boots `vite preview` automatically so the test
 * runs against the production build rather than the dev server.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'http://localhost:4173',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Don't spin a local server when PLAYWRIGHT_BASE_URL points at a
  // remote target (the deploy-staging workflow does this).
  webServer: process.env.PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: 'pnpm preview',
        url: 'http://localhost:4173',
        reuseExistingServer: !process.env.CI,
        timeout: 60_000,
      },
});
