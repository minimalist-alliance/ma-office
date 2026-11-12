// The Bible view's suite: Playwright against the harness (../dev), which runs the real bible-app. One worker, since the
// tests share one service and reset its data between them. MA_PW_PORT picks the port (4981 by default); BIBLE_APP_BIN
// points at a built bible-app (default ../dev/bin/bible-app, from `go build -o view/dev/bin/bible-app ./server` in
// apps/bible). SHOTS=1 also writes the review shots (shots.spec.ts) to SHOTS_DIR.
import { defineConfig } from '@playwright/test';

const port = Number(process.env.MA_PW_PORT || 4981);

export default defineConfig({
  testDir: '.',
  testMatch: process.env.SHOTS === '1' ? /\.spec\.ts$/ : /bible\.spec\.ts$/,
  workers: 1,
  fullyParallel: false,
  timeout: 30_000,
  expect: { timeout: 5_000 },
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${port}`, viewport: { width: 1280, height: 800 }, browserName: 'chromium' },
  webServer: {
    command: `node ../dev/server.mjs --port ${port}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    stdout: 'ignore',
    stderr: 'pipe',
  },
});
