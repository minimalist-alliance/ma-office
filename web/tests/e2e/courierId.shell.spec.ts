// Courier's own id where the office meets what's stored (docs/sub-status/courier-id.md). Everything on the page says
// `courier` (its tiles' ids, its window and empty state's test ids); what's stored, on Platform, in the mirror and in this
// browser's window places and app zoom, still says `chat` (`STORED_COURIER`), which release 19 and every build before it
// read. `src/canvas/courierId.test.ts` has the documents' rules; this is the real office, two browsers and the harness's Platform.
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { STORED_COURIER } from '../../src/canvas/storedIds';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

const ME = 'u-test';
const P = 'd-personal00001';
const W = 'd-work000000001';
const FLEET = [
  { deskId: P, name: 'Personal', kind: 'personal', state: 'running' },
  { deskId: W, name: 'Work', kind: 'work', state: 'running' },
];
interface Item { id: string; app: string; x: number; y: number; w: number; h: number }
interface Desk { x: number; y: number; w: number; h: number; items: Item[]; stack?: string[] }
interface Layout { schemaVersion: number; desks: Record<string, Desk>; z: string[] }
interface Seen { layoutDocs: Record<string, { version: number; layout: Layout | null } | undefined>; layoutPuts: { status: number; bytes: number }[] }

/** A first visit's row, as release 19 (and every build before Courier's id) saved it. */
const row = (id: string, courier = 'chat'): Item[] => [courier, 'notebook', 'browser', 'agent'].map((app, n) => ({ id: `${id}:${app}`, app, x: 24 + 92 * n, y: 24, w: 76, h: 76 }));
/**
 * The member's document as release 19 saved it, in its field order: Personal with Courier open-size and raised over the
 * Notebook, Work as a first visit left it. The desks in the order a save writes them (the top of `z` first).
 */
function release19(courier = 'chat'): Layout {
  const items = row(P, courier);
  items[0] = { ...items[0]!, w: 352, h: 352 };
  items[1] = { ...items[1]!, x: 392 };
  items[2] = { ...items[2]!, x: 484 };
  items[3] = { ...items[3]!, x: 576 };
  return {
    schemaVersion: 2,
    desks: {
      [P]: { x: 0, y: 0, w: 800, h: 500, items, stack: [`${P}:notebook`, `${P}:browser`, `${P}:agent`, `${P}:${courier}`] },
      [W]: { x: 900, y: 0, w: 584, h: 236, items: row(W, courier) },
    },
    z: [W, P],
  };
}
const OLD_APPS = ['notebook', 'browser', 'chat', 'agent', 'commons', 'files'];

const seen = async (request: APIRequestContext): Promise<Seen> => (await (await request.get('/__harness')).json()) as Seen;
const mirror = (page: Page): Promise<string | null> => page.evaluate(() => localStorage.getItem('ma.layout.v2'));
const proxyOf = (page: Page, id: string) => page.locator(`[id="proxy-${id}"]`);
const placeOf = (page: Page, id: string): Promise<{ x: number; y: number; w: number; h: number }> =>
  proxyOf(page, id).evaluate((el: HTMLElement) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }));

/** Seeded on the first load that's signed in: a start with nobody signed in wipes the member's caches (ISS-67, ISS-89). */
async function seedStorage(page: Page, entries: Record<string, string>): Promise<void> {
  await page.addInitScript((e) => {
    if (localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
    localStorage.setItem('test.seeded', '1');
    for (const [k, v] of Object.entries(e)) localStorage.setItem(k, v);
  }, entries);
}

async function arrive(page: Page): Promise<void> {
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(800);
}

async function another(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: test.info().project.use.baseURL });
  return ctx.newPage();
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('a layout release 19 saved opens with Courier as `courier` on the page, saves nothing by itself, and its mirror says what every build reads', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { fleet: FLEET, layoutDocs: { [ME]: { version: 3, updatedAt: '2026-11-12T20:00:00Z', layout: release19() } } });
  await arrive(page);
  await expect(proxyOf(page, `${P}:courier`)).toHaveCount(1);
  await expect(proxyOf(page, `${P}:chat`)).toHaveCount(0);
  expect(await placeOf(page, `${P}:courier`)).toEqual({ x: 24, y: 24, w: 352, h: 352 });
  await expect(page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Courier, coming later/ })).toHaveCount(1);
  await page.waitForTimeout(2_600); // past a save's debounce
  expect((await seen(request)).layoutPuts).toEqual([]);
  // The mirror: Courier as `STORED_COURIER`, `chat` during the transition, in its item and the stack.
  expect(STORED_COURIER).toBe('chat');
  await expect.poll(() => mirror(page), { timeout: 3_000 }).toContain(`{"id":"${P}:chat","app":"chat","x":24,"y":24,"w":352,"h":352}`);
  const stored = JSON.parse((await mirror(page))!) as Layout;
  expect(stored.desks[P]!.stack).toEqual([`${P}:notebook`, `${P}:browser`, `${P}:agent`, `${P}:chat`]);
  expect(await mirror(page)).not.toContain('courier');
  // Its window and empty state are Courier's by test id.
  await proxyOf(page, `${W}:courier`).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('window-courier')).toBeVisible();
  await expect(page.getByTestId('empty-courier')).toContainText('Courier is on its way');
  expect(errors).toEqual([]);
});

test('a move goes up as release 19 saves it, byte for byte, and the member\'s other browser takes it', async ({ browser, request }) => {
  await harness(request, { fleet: FLEET, layoutDocs: { [ME]: { version: 3, updatedAt: '2026-11-12T20:00:00Z', layout: release19() } } });
  const one = await another(browser);
  const two = await another(browser);
  for (const p of [one, two]) await arrive(p);
  // Courier on Work, down 40 from the keyboard (which raises it first).
  await proxyOf(one, `${W}:courier`).focus();
  await one.keyboard.press('m');
  await one.keyboard.press('Shift+ArrowDown');
  await one.keyboard.press('Enter');
  await expect.poll(async () => (await seen(request)).layoutPuts.filter((p) => p.status === 200).length, { timeout: 6_000 }).toBe(1);
  const up = (await seen(request)).layoutDocs[ME]!.layout!;
  const want = release19();
  want.desks[W]!.items[0]!.y = 64;
  want.desks[W]!.stack = [`${W}:notebook`, `${W}:browser`, `${W}:agent`, `${W}:chat`];
  // Byte for byte what release 19 would have sent for the same move: Work raised to the top, so it's written first.
  expect(JSON.stringify(up)).toBe(JSON.stringify({ schemaVersion: 2, desks: { [W]: want.desks[W], [P]: want.desks[P] }, z: [P, W] }));
  // Everything in it is an app release 19 reads.
  for (const d of Object.values(up.desks)) for (const i of d.items) expect(OLD_APPS, i.id).toContain(i.app);
  expect(up.desks[W]!.items[0]).toEqual({ id: `${W}:chat`, app: 'chat', x: 24, y: 64, w: 76, h: 76 });
  expect(up.desks[W]!.stack).toEqual([`${W}:notebook`, `${W}:browser`, `${W}:agent`, `${W}:chat`]);
  expect(up.desks[P]).toEqual(want.desks[P]); // a desk this browser didn't change goes up as it came down
  // The other browser.
  await two.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(() => placeOf(two, `${W}:courier`).then((b) => b.y), { timeout: 4_000 }).toBe(64);
  await two.waitForTimeout(2_600);
  expect((await seen(request)).layoutPuts.filter((p) => p.status === 200).length).toBe(1); // it takes it, and sends nothing back
  await one.context().close();
  await two.context().close();
});

test('a document from the release that writes `courier`, and release 19\'s mirror here: the same layout, and nothing goes back and forth', async ({ page, request }) => {
  const errors = watchConsole(page);
  // This browser's own copy from release 19 (with the desks' ids, as its mirror has them), and on Platform the next release's.
  const old = release19();
  const oldMirror = JSON.stringify({ desks: Object.fromEntries(Object.entries(old.desks).map(([id, d]) => [id, { id, ...d }])), z: old.z });
  await seedStorage(page, { 'ma.layout.v2': oldMirror });
  await harness(request, { fleet: FLEET, layoutDocs: { [ME]: { version: 4, updatedAt: '2026-11-20T20:00:00Z', layout: release19('courier') } } });
  await arrive(page);
  expect(await placeOf(page, `${P}:courier`)).toEqual({ x: 24, y: 24, w: 352, h: 352 });
  expect(await placeOf(page, `${W}:courier`)).toEqual({ x: 900 + 24, y: 24, w: 76, h: 76 });
  await page.waitForTimeout(2_600);
  expect((await seen(request)).layoutPuts).toEqual([]);
  expect((await seen(request)).layoutDocs[ME]!.version).toBe(4);
  expect(errors).toEqual([]);
});

test('Courier\'s window place and zoom, which release 19 kept as `chat`, are Courier\'s, and go back as `chat`', async ({ page, request }) => {
  await seedStorage(page, {
    'ma.windows.v1': JSON.stringify({ [`${W}:chat`]: { rect: { x: 300, y: 150, w: 720, h: 500 }, mode: 'window' } }),
    'ma.appZoom.v1': JSON.stringify({ chat: 150 }),
  });
  await harness(request, { fleet: FLEET, layoutDocs: { [ME]: { version: 3, updatedAt: '2026-11-12T20:00:00Z', layout: release19() } } });
  await arrive(page);
  await proxyOf(page, `${W}:courier`).focus();
  await page.keyboard.press('Enter');
  const win = page.getByTestId('window-courier');
  await expect(win).toBeVisible();
  await page.waitForTimeout(700); // its opening animation
  expect(await win.evaluate((el: HTMLElement) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }))).toEqual({ x: 300, y: 150, w: 720, h: 500 });
  expect(await win.locator('.window-body').evaluate((el: HTMLElement) => el.style.zoom)).toBe('1.5');
  await page.keyboard.press('Escape');
  await expect(win).toHaveCount(0);
  const rects = JSON.parse((await page.evaluate(() => localStorage.getItem('ma.windows.v1')))!) as Record<string, unknown>;
  expect(Object.keys(rects)).toEqual([`${W}:chat`]);
  expect(JSON.parse((await page.evaluate(() => localStorage.getItem('ma.appZoom.v1')))!)).toEqual({ chat: 150 });
});
