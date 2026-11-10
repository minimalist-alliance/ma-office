import { defineConfig, devices } from '@playwright/test';

// The built page, served by the stand-in guild server that each test starts (tests/e2e/server.ts).
// Chromium's fake microphone stands in for each member's. Other sessions share this machine:
// MA_CM_PORT moves the server off 5192 (and its voice port off 5193).
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 1,
    permissions: ['microphone'],
    launchOptions: {
      args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required'],
    },
  },
});
