import { defineConfig, devices } from '@playwright/test';

// The built demo behind `vite preview`, which sends the Desk harness's CSP as a header.
// Other sessions share this machine: MA_NB_PORT moves it if 5182 is taken.
export const PORT = Number(process.env['MA_NB_PORT'] ?? 5182);

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: { ...devices['Desktop Chrome'], baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 },
  webServer: {
    command: `npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}/`,
    reuseExistingServer: false,
  },
});
