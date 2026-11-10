import { defineConfig, devices } from '@playwright/test';

// One worker: one desk, one member. The machine running it must be on the desk's home network (README.md).
export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts$/,
  workers: 1,
  retries: 0,
  timeout: 20 * 60_000,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    ...devices['Desktop Chrome'],
    channel: 'chromium',
    viewport: { width: 1440, height: 900 },
    actionTimeout: 20_000,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    // No flags and no permissions: the member's own Chrome. It once ran with Local Network Access switched off, which
    // turned out not to matter: what stopped ICE was the port (README.md).
  },
});
