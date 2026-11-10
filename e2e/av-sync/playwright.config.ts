// The A/V sync harness (task 23), outside `testDir: 'tests'` so the release gate never runs it, and it skips unless AV_LABEL is
// set. Same browser as the gate: Chrome for Testing, new headless, with H.264.
import { defineConfig } from '@playwright/test';
import base from '../playwright.config';

// No DISPLAY, so nothing here can reach the Claude Desktop app's :10. --disable-audio-output gives Chrome its fake audio
// device, which plays in real time and makes no sound on this machine.
const { DISPLAY: _display, ...env } = process.env;

export default defineConfig({
  ...base,
  testDir: '.',
  testMatch: '*.spec.ts',
  outputDir: 'test-results',
  use: {
    ...base.use,
    headless: true,
    launchOptions: { env: env as Record<string, string>, args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', '--disable-audio-output'] },
  },
});
