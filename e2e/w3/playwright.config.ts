// The W3 harness, kept outside `testDir: 'tests'` so that `npx playwright test`, the release gate, never sees it. Each spec
// here also skips unless asked (W3_DESK or W3_PAIR). Same browser as the gate: Chrome for Testing, new headless, with H.264.
import { defineConfig } from '@playwright/test';
import base from '../playwright.config';

// Headless needs no display. Taking DISPLAY away means nothing here can ever reach the Claude Desktop app's :10.
const { DISPLAY: _display, ...env } = process.env;

export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: 'test-results',
  use: {
    ...base.use,
    headless: true,
    // As stream.spec.ts and proof2.mjs. Without the autoplay flag a video with sound won't play with no gesture.
    launchOptions: { env: env as Record<string, string>, args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] },
  },
});
