// The icons' shots in WebKit and Firefox (Playwright's builds, headless): the shell project's harness and bundle, two more
// browsers, only icons3d.shots's first test (its desk at 100 %). Run where both launch (Playwright's Docker image does):
//   ICONS3D_SHOTS=/abs/dir MA_PW_PORT=5181 npx playwright test -c tests/glyphs/playwright.xb.config.ts --workers=1
import { defineConfig, devices } from '@playwright/test';
import base, { E2E_PORT } from '../../playwright.config';

export default defineConfig({
  ...base,
  testDir: '../e2e',
  // WebKit's first page in a fresh browser can take longer than signIn's 5 s to show the office: one more try, shots only.
  retries: 1,
  projects: [
    { name: 'webkit', testMatch: /icons3d\.shots\.shell\.spec\.ts/, grep: /all seven apps/, use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 800 }, baseURL: `http://localhost:${E2E_PORT}` } },
    { name: 'firefox', testMatch: /icons3d\.shots\.shell\.spec\.ts/, grep: /all seven apps/, use: { ...devices['Desktop Firefox'], viewport: { width: 1280, height: 800 }, baseURL: `http://localhost:${E2E_PORT}` } },
  ],
  webServer: (base.webServer as { command: string }[]).slice(1).map((w) => ({ ...w, command: w.command.replace('harness/serve.mjs', '../../harness/serve.mjs').replace('dist/e2e', '../../dist/e2e') })),
});
