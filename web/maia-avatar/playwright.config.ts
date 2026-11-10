// Everything runs against scripts/serve.mjs on 127.0.0.1, under the apps' strict CSP. Build first (`npm run e2e` does).
// MAIA_TEST_PORT moves the server when another run holds the port.
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env['MAIA_TEST_PORT'] ?? 47920);

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: /.*\.spec\.ts$/,
  outputDir: 'test-results/output',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    ...devices['Desktop Chrome'],
    viewport: { width: 1280, height: 900 },
    deviceScaleFactor: 1,
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [
    { name: 'chromium', testIgnore: /(screenshots|capture)\.spec\.ts/ },
    // Writes screenshots/*.png, which stay local (.gitignore), so it runs only when asked: `npm run screenshots`.
    { name: 'screenshots', testMatch: /screenshots\.spec\.ts/ },
    // DANCE: writes dance/party-package.mp4 and dance/party-strip.png, which are committed: `npm run dance:capture`.
    { name: 'capture', testMatch: /capture\.spec\.ts/ },
  ],
  webServer: {
    command: `node scripts/serve.mjs --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: 'ignore',
  },
});
