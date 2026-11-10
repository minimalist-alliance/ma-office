import { defineConfig, devices } from '@playwright/test';

// One worker, serial: the workstation has two shared cores and the desk allows four sessions.
export default defineConfig({
  testDir: 'tests',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15 * 60_000,
  reporter: [['list']],
  outputDir: 'test-results',
  use: { ...devices['Desktop Chrome'], channel: 'chromium', viewport: { width: 1440, height: 900 }, actionTimeout: 20_000, trace: 'off', video: 'off', screenshot: 'off' },
});
