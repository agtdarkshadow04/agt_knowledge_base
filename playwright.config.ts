import { defineConfig } from '@playwright/test';

/**
 * Browser tests (TEST-6) against the built client, served with the production
 * headers by tests/e2e/serve.ts. Run `npm run build:client` first.
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE points at a preinstalled Chromium when the
 * one `npx playwright install chromium` would download is not available.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    browserName: 'chromium',
    trace: 'off',
    launchOptions: executablePath ? { executablePath } : {},
  },
  webServer: {
    command: 'node tests/e2e/serve.ts 4173',
    url: 'http://127.0.0.1:4173/',
    reuseExistingServer: false,
  },
});
