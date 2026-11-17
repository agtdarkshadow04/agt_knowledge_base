import { defineConfig } from '@playwright/test';
import { baseURL, prepare } from './tests/e2e/environment';

/**
 * Browser tests (TEST-6) against the built server and client
 * (`npm run test:e2e` builds both first), started by Playwright from first run
 * on a fresh database. The suite shares one server and its state, so it runs
 * with one worker; the first-run setup is its own project that the others
 * depend on, and it saves the signed-in states.
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE points at a preinstalled Chromium when the
 * one `npx playwright install --with-deps chromium` installs is not available.
 */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

// The config is also loaded in each worker: prepare the database only once, in the runner.
let serverEnv: Record<string, string> = JSON.parse(process.env.AGT_KB_E2E_SERVER_ENV ?? 'null');
if (!serverEnv) {
  serverEnv = prepare(process.env);
  process.env.AGT_KB_E2E_SERVER_ENV = JSON.stringify(serverEnv);
}

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  reporter: 'list',
  use: {
    baseURL,
    browserName: 'chromium',
    trace: 'retain-on-failure',
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: 'setup', testMatch: /setup\.spec\.ts/ },
    { name: 'chromium', testIgnore: /setup\.spec\.ts/, dependencies: ['setup'] },
  ],
  webServer: {
    command: 'node dist-server/index.mjs',
    url: `${baseURL}/api/health`,
    reuseExistingServer: false,
    env: serverEnv,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
