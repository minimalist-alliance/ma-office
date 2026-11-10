import { defineConfig, devices } from '@playwright/test';

// Other sessions run this on the same machine, and a port in use fails the whole run. MA_PW_PORT moves the pair.
export const RELEASE_PORT = Number(process.env['MA_PW_PORT'] ?? 4173);
export const E2E_PORT = RELEASE_PORT + 1;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  projects: [
    // MockDeskLink and fixtures: the shell, in all three themes.
    { name: 'shell', testMatch: /shell\.spec\.ts/, use: { baseURL: `http://localhost:${E2E_PORT}` } },
    // The bundle exactly as it ships: real loader path, CSP, real auth code over HTTP.
    { name: 'release', testMatch: /release\.spec\.ts/, use: { baseURL: `http://localhost:${RELEASE_PORT}` } },
    // The same bundle against a real desk-rtc, gateway-shim and fake-deskd. Full Chromium, for WebRTC.
    { name: 'rtc', testMatch: /rtc\.spec\.ts/, use: { baseURL: `http://localhost:${RELEASE_PORT}`, channel: 'chromium' } },
  ],
  webServer: [
    { command: `node harness/serve.mjs --dist dist/release --port ${RELEASE_PORT}`, port: RELEASE_PORT, reuseExistingServer: false },
    { command: `node harness/serve.mjs --dist dist/e2e --port ${E2E_PORT}`, port: E2E_PORT, reuseExistingServer: false },
  ],
});
