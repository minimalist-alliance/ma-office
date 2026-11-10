import { defineConfig, devices } from '@playwright/test';

// Other sessions run Playwright on the same machine, and a port in use fails the run. MA_AGENT_PORT moves it.
export const PORT = Number(process.env['MA_AGENT_PORT'] ?? 5194);

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  webServer: { command: `node tests/serve.mjs --port ${PORT}`, url: `http://127.0.0.1:${PORT}/`, reuseExistingServer: false },
});
