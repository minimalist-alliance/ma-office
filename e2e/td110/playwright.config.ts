import { defineConfig, devices } from '@playwright/test';

// TD-110 rerun, S-12 (a session opened while the desk is stopping). Outside the gate's testDir; skipped unless S12_DIR is set.
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 40 * 60_000,
  reporter: [['list']],
  outputDir: '../test-results-td110',
  use: { ...devices['Desktop Chrome'], channel: 'chromium', viewport: { width: 1440, height: 900 }, actionTimeout: 20_000 },
});
