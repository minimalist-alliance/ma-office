// The Agent window in the shipped app, on the staging test desk, as desk-1: a smoke check that it opens and that the desk's
// `agent` is connected (deskd's /health), with no real provider key. It only reads. It adds no key and sends no message,
// so nothing goes to a provider and nothing on the desk changes. Run it alone on the test desk, as browser-window.spec.ts.
// The deeper checks of the relay are agent-relay.spec.ts (through the rpc channel) and web/tests/real-desk/rt-agent.mjs.
//
//   npx playwright test tests/agent-check.spec.ts --output test-results-agent-check
import { mkdirSync } from 'node:fs';
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { DESK_ID, INSTANCE, deskTruth, focusTestDesk, loadUser, signInApp, watch, type Watch } from './lib';

const SHOT = 'screenshots/agent-check.png';

let context: BrowserContext;
let page: Page;
let w: Watch;

test.setTimeout(3 * 60_000);

test.beforeAll(async ({ browser }) => {
  mkdirSync('screenshots', { recursive: true });
  if (!INSTANCE || INSTANCE !== process.env['E2E_TEST_INSTANCE']) throw new Error('this suite only ever runs on the staging test desk');
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  w = watch(page);
  await signInApp(context, page, loadUser('desk-1'));
});

test.afterAll(async () => {
  await context?.close();
});

test('the Agent window opens on the test desk and the desk reports agent: connected', async () => {
  const truth = await deskTruth();
  expect(truth.deskId).toBe(DESK_ID);
  console.log(`[agent-check] desk: ${JSON.stringify({ deskdVersion: truth.deskdVersion, agent: truth.health.agent })}`);
  expect(truth.health.agent, '/health: desk-agent is connected to deskd').toBe('connected');

  await focusTestDesk(page, w);
  // Through the keyboard, as browser-window.spec.ts and skeleton.spec.ts: the desk's proxy, then the app's own proxy.
  await page.locator(`#proxy-${DESK_ID}`).focus();
  await page.keyboard.press('Enter');
  const proxy = page.locator(`[id="proxy-${DESK_ID}:agent"]`);
  await proxy.waitFor({ state: 'attached', timeout: 30_000 });
  await proxy.focus();
  await page.keyboard.press('Enter');

  const win = page.getByRole('dialog', { name: 'Agent' }).first();
  await expect(win, 'the Agent window opened').toBeVisible({ timeout: 15_000 });
  // The first screen depends on the account: key setup with no key, else the agent's state or its thread. Any of them
  // means the window reached desk-agent through deskd's relay.
  const first = win.getByTestId('key-setup').or(win.getByTestId('agent-state')).or(win.getByTestId('thread')).first();
  await expect(first, 'the window got past its loading state').toBeVisible({ timeout: 45_000 });
  await page.screenshot({ path: SHOT });
  expect(w.errors, 'no console or CSP errors').toEqual([]);
});
