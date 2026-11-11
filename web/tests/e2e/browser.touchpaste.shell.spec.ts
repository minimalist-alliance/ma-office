// The phone Paste key (#12, Security's condition of Nov 11): in the typing row, one `readText` per tap and only from that
// tap, its text straight to the desk as one clipboard write and a Control+V, and a refusal says its line and sends nothing.
// At 390 x 844 with touch, on MockDeskLink, in Light, Zen and Dark. `TPASTE_SHOTS=<dir>` keeps stills of the row.
import { expect, test, type APIRequestContext, type CDPSession, type Locator, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const SHOTS = process.env['TPASTE_SHOTS'];
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const REFUSED = "Your browser didn't allow that paste.";
const EMPTY = "There's nothing to paste.";
const DESK = 'd-personal00001';
const fleet = [
  { deskId: DESK, name: 'Personal', kind: 'personal', state: 'running' },
  { deskId: 'd-work000000001', name: 'Work', kind: 'work', state: 'running' },
];

interface Sent {
  channel: 'input' | 'keys';
  bytes: number[];
}
interface Event {
  type: number;
  down: number;
  button: number;
  x: number;
  y: number;
  keysym: number;
}
interface View {
  mode: string;
  region?: { x: number; y: number; width: number; height: number };
  screen?: { width: number; height: number };
}
type Mock = {
  __maDeskMock: {
    input: Sent[];
    rpc: { m: string; p: Record<string, unknown> }[];
    phoneView: boolean;
    view: Record<string, View>;
    deviceLog: { deskId: string; device: { width: number; height: number } | null }[];
    setField(deskId: string, field: unknown): void;
    setView(deskId: string, view: unknown): void;
  };
};

const KEY = 4;
const decode = ({ bytes }: Sent): Event => {
  const v = new DataView(new Uint8Array(bytes).buffer);
  return { type: v.getUint8(0), down: v.getUint8(1), button: v.getUint8(2), x: v.getUint16(8), y: v.getUint16(10), keysym: v.getUint32(12) };
};
const sent = async (page: Page): Promise<Event[]> => (await page.evaluate(() => (window as unknown as Mock).__maDeskMock.input)).map(decode);
const clear = (page: Page): Promise<void> =>
  page.evaluate(() => {
    (window as unknown as Mock).__maDeskMock.input.length = 0;
    (window as unknown as Mock).__maDeskMock.rpc.length = 0;
  });
const keyEvents = async (page: Page): Promise<[number, number][]> => (await sent(page)).filter((e) => e.type === KEY).map((e) => [e.down, e.keysym]);
const streamCalls = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as Mock).__maDeskMock.rpc.filter((r) => r.m === 'browser.stream.set').map((r) => r.p['state'] as string));

const video = (page: Page): Locator => page.getByTestId('browser-video');
const pageRow = (page: Page): Locator => page.getByRole('toolbar', { name: 'Page controls' });
const keyRow = (page: Page): Locator => page.getByRole('toolbar', { name: 'Keys for the page' });
const slide = (page: Page): Locator => page.locator('.carousel-slide:not(.leaving)');

async function press(page: Page, l: Locator): Promise<void> {
  const b = (await l.boundingBox())!;
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
}

async function openBrowser(page: Page, request: APIRequestContext, theme: ThemeId, phoneView = false): Promise<CDPSession> {
  await setTheme(page, theme);
  await harness(request, { fleet });
  await signIn(page);
  await canvasPainted(page);
  if (phoneView)
    await page.evaluate(() => {
      (window as unknown as Mock).__maDeskMock.phoneView = true;
    });
  await focusCanvas(page);
  await page.keyboard.press('1');
  await expect.poll(() => page.evaluate(() => (window as unknown as { __maDesk: { camera: { isMoving(): boolean } } }).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(250);
  await press(page, page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Browser/ }));
  await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, \d of \d$/);
  await expect.poll(async () => (await streamCalls(page)).at(-1)).toBe('live');
  await expect.poll(() => video(page).evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(1280);
  await page.waitForTimeout(400);
  await clear(page);
  return page.context().newCDPSession(page);
}

type Reads = { __reads: number; __mode: 'grant' | 'refuse' | 'empty' };
const reads = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as Reads).__reads);
const writes = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as Mock).__maDeskMock.rpc.filter((r) => r.m === 'browser.clipboard.write').map((r) => r.p['text'] as string));
const mode = (page: Page, m: Reads['__mode']): Promise<void> => page.evaluate((x) => { (window as unknown as Reads).__mode = x; }, m);

test.beforeEach(async ({ page, request }) => {
  await harness(request, { reset: true });
  // Counts every read the app makes of the phone's clipboard, and answers as the phone would.
  await page.addInitScript(() => {
    const w = window as unknown as Reads;
    w.__reads = 0;
    w.__mode = 'grant';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        readText: () => {
          w.__reads += 1;
          if (w.__mode === 'refuse') return Promise.reject(new DOMException('no', 'NotAllowedError'));
          return Promise.resolve(w.__mode === 'empty' ? '' : 'hello from the phone');
        },
        writeText: () => Promise.resolve(),
      },
    });
  });
});

test.use({ viewport: { width: 390, height: 844 }, screen: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

for (const theme of THEMES) {
  test(`${theme}: Paste is in the typing row; no read until a tap; one read and one paste per tap; a refusal says its line`, async ({ page, request }) => {
    const errors = watchConsole(page);
    await openBrowser(page, request, theme);
    await press(page, pageRow(page).getByRole('button', { name: 'Keyboard' }));
    const paste = keyRow(page).getByRole('button', { name: 'Paste', exact: true });
    await expect(paste).toBeVisible();
    const b = (await paste.boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(44);
    expect(b.height).toBeGreaterThanOrEqual(44);

    // Mount, focus, blur, visibility and time: no read.
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('blur'));
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(600);
    expect(await reads(page)).toBe(0);

    await clear(page);
    await press(page, paste);
    await expect.poll(() => writes(page)).toEqual(['hello from the phone']);
    expect(await reads(page)).toBe(1);
    await expect.poll(() => keyEvents(page)).toEqual([[1, 0xffe3], [1, 0x76], [0, 0x76], [0, 0xffe3]]);
    if (SHOTS) await page.screenshot({ path: SHOTS + '/paste-' + theme + '.png' });

    // Refused: the line, no write, no key, one read, no second try.
    await mode(page, 'refuse');
    await clear(page);
    await press(page, paste);
    await expect(page.getByRole("status").filter({ hasText: REFUSED })).toBeVisible();
    await page.waitForTimeout(500);
    expect(await reads(page)).toBe(2);
    expect(await writes(page)).toEqual([]);
    expect(await keyEvents(page)).toEqual([]);
    if (SHOTS) await page.screenshot({ path: SHOTS + '/refused-' + theme + '.png' });

    // Empty: its own line, nothing sent.
    await mode(page, 'empty');
    await press(page, paste);
    await expect(page.getByRole("status").filter({ hasText: EMPTY })).toBeVisible();
    expect(await reads(page)).toBe(3);
    expect(await writes(page)).toEqual([]);
    expect(errors).toEqual([]);
  });
}
