import { defineConfig, devices } from '@playwright/test';

// The release checks of 2026-11-10 (docs/sub-status/files-release-1110.md): outside the gate's testDir, serial, test desk only.
export default defineConfig({
  testDir: '.',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 10 * 60_000,
  reporter: [['list']],
  outputDir: '../test-results-release-1110',
  use: { ...devices['Desktop Chrome'], channel: 'chromium', viewport: { width: 1440, height: 900 }, actionTimeout: 20_000 },
});
