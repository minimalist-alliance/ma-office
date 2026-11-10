// The member's first click, keys and paste on a desk that serves the simplified view (section 14) but is slow to answer
// for a page, as the real test desk is (seconds, Nov 10): `e2e/` `browser-window.spec.ts` step 4 and `clipboard.spec.ts`
// lost them to an empty cover over a page the member could see. The page stays the real page, live, until its document
// is in hand; the view covers only then, and T47O-2's keyboard rules hold from there to the moment it steps aside.
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

interface Control {
  rpc: { m: string; p: Record<string, unknown> }[];
  input: { channel: string; bytes: number[] }[];
  deskClipboard: string | null;
  setTabs(tabs: unknown[]): void;
  simple: { serves: boolean; delayMs: number };
}
type Win = { __maDeskMock: Control };

const BUTTON = 2;
const KEY = 4;
const DOWN = 1;
const V = 0x76;

const mock = <T, A = undefined>(page: Page, fn: (c: Control, arg: A) => T, arg?: A): Promise<T> =>
  page.evaluate(`(${fn.toString()})(window.__maDeskMock, ${JSON.stringify(arg ?? null)})`) as Promise<T>;
/** What went to the desk's input, as [channel, type, down, button or keysym]. */
const sent = (page: Page): Promise<[string, number, number, number][]> =>
  page.evaluate(() =>
    (window as unknown as Win).__maDeskMock.input.map((e): [string, number, number, number] => {
      const v = new DataView(new Uint8Array(e.bytes).buffer);
      const type = v.getUint8(0);
      return [e.channel, type, v.getUint8(1), type === 4 ? v.getUint32(12) : v.getUint8(2)];
    }),
  );
const clear = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as unknown as Win).__maDeskMock.input.length = 0;
  });
const buttons = async (page: Page) => (await sent(page)).filter(([, type]) => type === BUTTON).map(([channel, , down, button]) => [channel, down, button]);
const keyDowns = async (page: Page) => (await sent(page)).filter(([, type, down]) => type === KEY && down === DOWN).map(([, , , sym]) => sym);
const calls = (page: Page, m: string) => mock(page, (c, method) => c.rpc.filter((r) => r.m === method).map((r) => r.p), m);
const streamStates = (page: Page): Promise<string[]> => mock(page, (c) => c.rpc.filter((r) => r.m === 'browser.stream.set').map((r) => r.p['state'] as string));

const win = (page: Page) => page.getByRole('dialog', { name: /Browser/ });
const video = (page: Page) => page.getByTestId('browser-video');
const keys = (page: Page) => page.getByTestId('browser-keys');
const address = (page: Page) => page.getByTestId('browser-address');
const simpleView = (page: Page) => page.getByTestId('simple-view');

/** The desk serves section 14 and takes `ms` to answer for a page, from the moment the tab gets there. */
async function arrive(page: Page, ms: number): Promise<void> {
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await mock(page, (c, a) => {
    c.simple.serves = true;
    c.simple.delayMs = a;
  }, ms);
}

async function goTo(page: Page, url: string): Promise<void> {
  await mock(page, (c, u) => c.setTabs([{ tabId: 't1', url: u, title: new URL(u).hostname, loading: false, active: true, canGoBack: true, canGoForward: false }]), url);
}

async function openBrowser(page: Page): Promise<void> {
  await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(win(page)).toBeVisible();
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1280);
  await page.waitForTimeout(300); // the FLIP
}

/** A real click in the picture, where the member sees the page. */
async function clickPicture(page: Page, fx = 0.3, fy = 0.4): Promise<void> {
  const b = (await video(page).boundingBox())!;
  const [w, h] = await video(page).evaluate((v: HTMLVideoElement) => [v.videoWidth, v.videoHeight] as const);
  const scale = Math.min(b.width / w, b.height / h);
  await page.mouse.click(b.x + (b.width - w * scale) / 2 + w * scale * fx, b.y + (b.height - h * scale) / 2 + h * scale * fy);
}

/** Click, keys and a real Ctrl+V on the page, each landing on the desk as on a desk without the view. */
async function clickTypePaste(page: Page, text: string): Promise<void> {
  await clear(page);
  // Now, not eventually: an empty cover came and went in this window before.
  expect(await simpleView(page).count(), 'nothing covers the page the member sees').toBe(0);
  await clickPicture(page);
  await expect(keys(page), 'the click gave the stream the keyboard').toBeFocused();
  expect(await buttons(page), 'the click reached the page').toEqual([['keys', 1, 1], ['keys', 0, 1]]);
  await page.keyboard.type('ab');
  await expect.poll(() => keyDowns(page)).toEqual([0x61, 0x62]);
  const writes = (await calls(page, 'browser.clipboard.write')).length;
  await page.evaluate((t) => navigator.clipboard.writeText(t), text);
  await page.keyboard.press('Control+v');
  await expect.poll(async () => (await calls(page, 'browser.clipboard.write')).length).toBe(writes + 1);
  expect((await calls(page, 'browser.clipboard.write')).at(-1)).toEqual({ text });
  await expect.poll(async () => (await keyDowns(page)).filter((s) => s === V).length, { message: 'the paste pressed V once' }).toBe(1);
  expect(await page.evaluate(() => (window as unknown as Win).__maDeskMock.deskClipboard)).toBe(text);
  expect(await simpleView(page).count(), 'nor did it while the member worked').toBe(0);
}

test.beforeEach(async ({ request, context }) => {
  await harness(request, { reset: true });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
});

test('a page the desk is slow to answer for stays the real page: a click, keys and a paste right after the window opens, and right after Enter, all reach it', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page, 2_500);
  await goTo(page, 'https://map.example/');
  await openBrowser(page);
  // Past the 300 ms after which an empty cover used to come over the page while the desk was still answering.
  await page.waitForTimeout(150);
  await clickTypePaste(page, 'first paste');

  // The address bar, then Enter: the keyboard goes to the stream, and the page stays the real page while the desk answers.
  await address(page).click();
  await address(page).fill('https://check.example/');
  await address(page).press('Enter');
  await expect(keys(page)).toBeFocused();
  await page.waitForTimeout(450);
  await clickTypePaste(page, 'second paste');
  // The desk's no comes, with its line; nothing covered at any point, and the stream never went warm.
  await expect(page.getByTestId('browser-simple-line')).toHaveText("The site wants to check you're human", { timeout: 5_000 });
  await expect(simpleView(page)).toHaveCount(0);
  expect(await streamStates(page)).not.toContain('warm');
  expect(errors).toEqual([]);
});

test('the document in hand covers, and the keyboard never reaches the real page under it (T47O-2); as the view steps aside the keyboard comes back to the stream', async ({ page }) => {
  const errors = watchConsole(page);
  await arrive(page, 1_000);
  await goTo(page, 'https://gone.example/');
  await openBrowser(page);
  await address(page).click();
  await address(page).fill('https://read.example/essay');
  await address(page).press('Enter');
  await expect(keys(page)).toBeFocused();
  // While the desk answers, the real page has the keyboard.
  await page.waitForTimeout(450);
  expect(await simpleView(page).count()).toBe(0);
  await clear(page);
  await page.keyboard.type('a');
  await expect.poll(() => keyDowns(page)).toEqual([0x61]);
  // Its yes: the view covers, and takes the keyboard, so nothing typed goes to the page under it.
  await expect(simpleView(page)).toHaveAttribute('data-view', 'simple', { timeout: 3_000 });
  await expect(page.getByTestId('simple-scroll')).toBeFocused();
  await expect(page.locator('.br-surface')).toHaveAttribute('inert', '');
  await clear(page);
  await page.keyboard.type('xy');
  await page.keyboard.press('Space');
  await page.getByTestId('simple-scroll').click({ position: { x: 4, y: 4 } });
  await page.keyboard.press('Control+v');
  expect(await sent(page)).toEqual([]);
  expect(await calls(page, 'browser.text.insert')).toEqual([]);
  expect(await calls(page, 'browser.clipboard.write')).toEqual([]);
  // The tab goes on by itself to a page the desk says no to: the view stays over it until it answers, then steps aside,
  // and the keyboard is the stream's again.
  await goTo(page, 'https://bank.example/');
  await expect(simpleView(page)).toHaveCount(0, { timeout: 4_000 });
  await expect(keys(page)).toBeFocused();
  await clear(page);
  await page.keyboard.type('b');
  await expect.poll(() => keyDowns(page)).toEqual([0x62]);
  expect(errors).toEqual([]);
});
