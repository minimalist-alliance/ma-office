// TD-212's real-sites check, kept outside `testDir: 'tests'` so that `npx playwright test`, the release gate, never sees it.
// The spec also skips unless REAL_SITES=1. Same browser and flags as the W3 kit: Chrome for Testing, new headless, with H.264.
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
    launchOptions: { env: env as Record<string, string>, args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] },
  },
});
