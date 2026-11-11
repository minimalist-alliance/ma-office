// Measures `media.browserLiveSeconds` (ADR 0090) on the staging test desk through staging's real Desk app, as the e2e test account.
// The heartbeat's field is deskd's BrowserTime.liveSecondsSinceBoot; the same count is saved to /run/desk/browser-live.json
// (every 10 s while counting and, forced, when counting stops), which this reads over SSM. Readings that matter are taken >= 15 s
// after the count stopped, so the file is exact. Run after the gate, never beside it:
//   npx playwright test -c release-1110 browser-live.spec.ts
import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { DESK_ID, INSTANCE, focusTestDesk, loadUser, onDesk, signInApp, watch, type Watch } from '../tests/lib';
import { sleep } from '../tests/streamlib';

test.describe.configure({ mode: 'serial' });
const note = (k: string, v: unknown) => console.log(`[live] ${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);

async function liveSec(): Promise<number> {
  const out = await onDesk('cat /run/desk/browser-live.json 2>/dev/null || echo "{}"');
  const j = JSON.parse(out.trim().split('\n').pop() || '{}');
  return typeof j.liveMs === 'number' ? j.liveMs / 1000 : 0;
}

let context: BrowserContext;
let page: Page;
let w: Watch;

async function openBrowser(p: Page, ww: Watch) {
  const deskName = await focusTestDesk(p, ww);
  const deskProxy = p.locator(`#proxy-${DESK_ID}`);
  await deskProxy.focus();
  await p.keyboard.press('Enter');
  const tile = deskProxy.locator('..').getByRole('button', { name: /^Browser/ });
  let box = await tile.boundingBox();
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    const now = await tile.boundingBox();
    if (now && JSON.stringify(now) === JSON.stringify(box)) break;
    box = now;
  }
  if (!box) throw new Error('no Browser tile');
  const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];
  await p.mouse.move(x, y);
  await sleep(150);
  await p.mouse.click(x, y);
  const win = p.getByRole('dialog', { name: /Browser/ });
  await expect(win).toBeVisible({ timeout: 15_000 });
  await expect(win.getByTestId('browser-panel')).toHaveCount(0, { timeout: 90_000 });
  const video = win.getByLabel("The page in this desk's browser", { exact: true });
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => !v.paused && v.videoWidth > 0), { timeout: 30_000 }).toBe(true);
  return { win, deskName, t: Date.now() };
}
async function closeBrowser(p: Page) {
  const win = p.getByRole('dialog', { name: /Browser/ });
  await win.getByRole('button', { name: 'Close Browser', exact: true }).click();
  await expect(win).toHaveCount(0);
  return Date.now();
}
const setHidden = (p: Page, hidden: boolean) =>
  p.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (h ? 'hidden' : 'visible') });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);

test.beforeAll(async ({ browser }) => {
  if (!INSTANCE || INSTANCE !== process.env['E2E_TEST_INSTANCE']) throw new Error('test desk only');
  context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await context.newPage();
  w = watch(page);
  await signInApp(context, page, loadUser('desk-1'));
});
test.afterAll(async () => { await context?.close(); });

test('0 warm-up: the window opens once and closes (Chromium up), not measured', async () => {
  test.setTimeout(5 * 60_000);
  await openBrowser(page, w);
  await sleep(5000);
  await closeBrowser(page);
  await sleep(15_000);
  note('0 reading after warm-up', await liveSec());
});

test('a visible and live for 120 s', async () => {
  test.setTimeout(6 * 60_000);
  const before = await liveSec();
  const { t } = await openBrowser(page, w);
  await sleep(Math.max(0, 120_000 - (Date.now() - t)));
  const held = (Date.now() - t) / 1000;
  const mid = await liveSec(); // stale by up to 10 s while counting
  const tClose = await closeBrowser(page);
  await sleep(15_000);
  const after = await liveSec();
  note('a', { before, mid, after, grew: +(after - before).toFixed(1), videoShownToClose: +((tClose - t) / 1000).toFixed(1), heldBeforeMidReading: +held.toFixed(1) });
});

test('b open window, office tab hidden (emulated visibility), then a minimise attempt', async () => {
  test.setTimeout(8 * 60_000);
  const before = await liveSec();
  const { t } = await openBrowser(page, w);
  await sleep(20_000);
  const tHide = Date.now();
  await setHidden(page, true);
  await sleep(15_000);
  const r1 = await liveSec();
  await sleep(Math.max(0, 120_000 - (Date.now() - tHide)));
  const r2 = await liveSec();
  const tShow = Date.now();
  await setHidden(page, false);
  await sleep(10_000);
  const r3 = await liveSec();
  note('b', {
    before, visibleBeforeHideS: +((tHide - t) / 1000).toFixed(1), afterHide15s: r1, afterHide120s: r2, hiddenS: +((tShow - tHide) / 1000).toFixed(1),
    visibleAgain10s: r3, grewWhileVisible: +(r1 - before).toFixed(1), grewWhileHidden: +(r2 - r1).toFixed(1),
  });
  // A real minimise through CDP: does the page become hidden in this browser at all?
  const cdp = await context.newCDPSession(page);
  let minimised: unknown = 'not attempted';
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
    await sleep(2000);
    minimised = await page.evaluate(() => ({ hidden: document.hidden, state: document.visibilityState }));
    if ((minimised as { hidden: boolean }).hidden) {
      const m0 = await liveSec();
      await sleep(60_000);
      const m1 = await liveSec();
      minimised = { ...(minimised as object), grewIn60s: +(m1 - m0).toFixed(1) };
    }
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
  } catch (e) { minimised = `cdp: ${(e as Error).message.slice(0, 120)}`; }
  note('b minimise', minimised);
  await closeBrowser(page);
  await sleep(15_000);
});

test('c three Browser tabs, one shown live, for 120 s', async () => {
  test.setTimeout(8 * 60_000);
  const before = await liveSec();
  const { win, t } = await openBrowser(page, w);
  const tabs = win.getByTestId('browser-tab');
  const n0 = await tabs.count();
  const added: string[] = [];
  for (let i = 0; i < 2; i++) {
    const c = await tabs.count();
    await win.getByRole('button', { name: 'New tab', exact: true }).click();
    await expect(tabs).toHaveCount(c + 1, { timeout: 20_000 });
  }
  const n1 = await tabs.count();
  await sleep(Math.max(0, 120_000 - (Date.now() - t)));
  const tClose = Date.now();
  // close the tabs this scenario made (the active one each time), leaving the desk's own
  for (let i = n1; i > n0; i--) {
    await win.getByTestId('browser-tab').filter({ has: page.getByRole('tab', { selected: true }) }).getByRole('button', { name: /^Close/ }).first().click({ timeout: 5000 }).catch(() => added.push('close failed'));
    await sleep(500);
  }
  await closeBrowser(page);
  await sleep(15_000);
  const after = await liveSec();
  note('c', { before, after, grew: +(after - before).toFixed(1), tabsBefore: n0, tabsOpen: n1, tabsNow: 'see desk', videoShownToClose: +((tClose - t) / 1000).toFixed(1), notes: added });
});

test('d simplified view on a Wikipedia page for 120 s', async () => {
  test.setTimeout(8 * 60_000);
  const before = await liveSec();
  const { win, t } = await openBrowser(page, w);
  await win.getByRole('button', { name: 'New tab', exact: true }).click();
  const address = win.getByRole('textbox', { name: 'Address' });
  await address.click();
  await address.fill('https://en.wikipedia.org/wiki/Cat');
  await address.press('Enter');
  const simple = win.getByRole('radio', { name: /^Simplified/ });
  let shown = false;
  try { await expect(simple).toHaveAttribute('aria-checked', 'true', { timeout: 60_000 }); shown = true; } catch { shown = false; }
  const tSimple = Date.now();
  const radios = await win.getByRole('radio').evaluateAll((els) => els.map((e) => `${e.getAttribute('aria-label') ?? e.textContent}:${e.getAttribute('aria-checked')}`)).catch(() => []);
  note('d view', { simplifiedShown: shown, radios });
  const mid0 = await liveSec();
  await sleep(120_000);
  const mid1 = await liveSec();
  const tEnd = Date.now();
  // leave the view's page: close this scenario's tab, then the window
  await win.getByTestId('browser-tab').filter({ has: page.getByRole('tab', { selected: true }) }).getByRole('button', { name: /^Close/ }).first().click({ timeout: 5000 }).catch(() => {});
  await closeBrowser(page);
  await sleep(25_000);
  const after = await liveSec();
  note('d', { before, readingAtViewStart: mid0, readingAt120s: mid1, after, simplifiedSeconds: +((tEnd - tSimple) / 1000).toFixed(1), grewDuring120sOfView: +(mid1 - mid0).toFixed(1), grewTotal: +(after - before).toFixed(1), windowOpenedToEnd: +((tEnd - t) / 1000).toFixed(1) });
});

test('e nothing open for 120 s', async () => {
  test.setTimeout(5 * 60_000);
  const before = await liveSec();
  await sleep(120_000);
  const after = await liveSec();
  note('e', { before, after, grew: +(after - before).toFixed(1) });
});

test('f two sessions both live for 60 s', async ({ browser }) => {
  test.setTimeout(8 * 60_000);
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  try {
    const page2 = await ctx2.newPage();
    const w2 = watch(page2);
    await signInApp(ctx2, page2, loadUser('desk-1'));
    const before = await liveSec();
    const a = await openBrowser(page, w);
    const b = await openBrowser(page2, w2);
    const tBoth = Date.now();
    await sleep(60_000);
    const tEnd = Date.now();
    await closeBrowser(page);
    const tClose1 = Date.now();
    await closeBrowser(page2);
    const tClose2 = Date.now();
    await sleep(15_000);
    const after = await liveSec();
    note('f', {
      before, after, grew: +(after - before).toFixed(1), firstOpenToSecondClose: +((tClose2 - a.t) / 1000).toFixed(1), bothLiveS: +((tEnd - tBoth) / 1000).toFixed(1),
      secondSessionLiveFromFirstOpen: +((tClose2 - b.t) / 1000).toFixed(1), closeGapS: +((tClose2 - tClose1) / 1000).toFixed(1),
    });
  } finally { await ctx2.close(); }
});
