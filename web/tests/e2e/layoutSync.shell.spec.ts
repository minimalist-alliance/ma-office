// The layout on Platform where it meets everything else on `main`: desks that never overlap, stacks, what's in progress
// on the canvas, old defaults and who's signed in. shell.spec.ts has the sync's own rules; this has where they meet.
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

const A = 'd-personal00001';
const B = 'd-work000000001';
const C = 'd-guild00000001';
const NAMES: Record<string, [string, string]> = { [A]: ['Personal', 'personal'], [B]: ['Work', 'work'], [C]: ['Guild', 'guild'] };
const GAP = 24;
const ME = 'u-test';

interface Box { x: number; y: number; w: number; h: number }
interface Item extends Box { id: string; app: string }
interface SavedDesk extends Box { items: Item[]; stack?: string[] }
interface Saved { schemaVersion: number; desks: Record<string, SavedDesk>; z: string[] }
interface Doc { version: number; updatedAt: string | null; layout: Saved | null }
interface Put { status: number; ifMatch: string | null; bytes: number; at: number; user: string }
interface Get { status: number; ifNoneMatch: string | null; at: number; user: string }
interface Harness { layoutDocs: Record<string, Doc | undefined>; layoutPuts: Put[]; layoutGets: Get[] }

const fleet = (ids: string[]): Record<string, string>[] => ids.map((deskId) => ({ deskId, name: NAMES[deskId]![0], kind: NAMES[deskId]![1], state: 'running' }));
const box = (x: number, y: number, w = 400, h = 200): Box => ({ x, y, w, h });
const item = (id: string, app: string, x: number, y: number, w = 76, h = 76): Item => ({ id, app, x, y, w, h });
const apps = (deskId: string): Item[] => [item(`${deskId}:chat`, 'chat', 24, 24), item(`${deskId}:notebook`, 'notebook', 116, 24), item(`${deskId}:browser`, 'browser', 208, 24), item(`${deskId}:agent`, 'agent', 300, 24)];

/** A document as Platform holds it. Desks that aren't given apps get the usual row, since a desk with none has nothing to focus. */
const docOf = (version: number, desks: Record<string, Box & { items?: Item[]; stack?: string[] }>, z = Object.keys(desks)): Doc => ({
  version,
  updatedAt: '2026-11-06T00:00:00Z',
  // In the order the app writes a desk's fields, so a test can compare bytes.
  layout: { schemaVersion: 2, desks: Object.fromEntries(Object.entries(desks).map(([id, { x, y, w, h, items, stack }]) => [id, { x, y, w, h, items: items ?? apps(id), ...(stack ? { stack } : {}) }])), z },
});

const server = async (request: APIRequestContext): Promise<Harness> => (await (await request.get('/__harness')).json()) as Harness;
const saved = async (request: APIRequestContext, who = ME): Promise<Doc | undefined> => (await server(request)).layoutDocs[who];
const putsOf = async (request: APIRequestContext): Promise<Put[]> => (await server(request)).layoutPuts;
/** The app's own console errors. A browser logs a failed request by itself, and no app code can stop that. */
const ownErrors = (errors: string[]): string[] => errors.filter((e) => !e.includes('Failed to load resource') && !e.includes('net::ERR_'));

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

/** Signed in and at rest, with `doc` on Platform and, if given, `mirror` as this browser's own copy from an earlier build. */
async function open(page: Page, request: APIRequestContext, ids: string[], doc?: Doc, mirror?: string): Promise<void> {
  if (mirror) {
    await page.addInitScript((d) => {
      if (localStorage.getItem('test.seeded')) return;
      localStorage.setItem('test.seeded', '1');
      localStorage.setItem('ma.layout.v2', d);
    }, mirror);
  }
  await harness(request, { fleet: fleet(ids), ...(doc ? { layoutDocs: { [ME]: doc } } : {}) });
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(800);
}

/** A read at once: back online skips the gap between reads, which is 5 s from a focus. */
async function readNow(page: Page, request: APIRequestContext): Promise<void> {
  const before = (await server(request)).layoutGets.length;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await server(request)).layoutGets.length, { timeout: 4_000 }).toBeGreaterThan(before);
  await page.waitForTimeout(50);
}

type Hook = { __maDesk: { camera: { cam: { x: number; y: number; s: number }; getStage(): { find(q: string): { id(): string; x(): number; y(): number }[] } } } };
const nodes = (page: Page): Promise<Record<string, { x: number; y: number }>> => page.evaluate(() => Object.fromEntries((window as unknown as Hook).__maDesk.camera.getStage().find('.desk').map((n) => [n.id().slice(5), { x: n.x(), y: n.y() }])));
const cam = (page: Page): Promise<{ x: number; y: number; s: number }> => page.evaluate(() => ({ ...(window as unknown as Hook).__maDesk.camera.cam }));
const proxy = (page: Page, id: string) => page.locator(`[id="proxy-${id}"]`);
const proxied = (page: Page, id: string): Promise<Box> => proxy(page, id).evaluate((el: HTMLElement) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }));
const mirrorOf = (page: Page): Promise<{ desks: Record<string, SavedDesk & { id: string }>; z: string[] } | null> => page.evaluate(() => JSON.parse(localStorage.getItem('ma.layout.v2') ?? 'null'));
const syncRecord = (page: Page): Promise<{ dirty: string[]; member?: string | null } | null> => page.evaluate(() => JSON.parse(localStorage.getItem('ma.layout.sync.v1') ?? 'null'));
const gapBetween = (a: Box, b: Box): number => Math.max(b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));

const toScreen = async (page: Page, x: number, y: number): Promise<{ x: number; y: number }> => {
  const c = await cam(page);
  return { x: x * c.s + c.x, y: y * c.s + c.y };
};

/** A desk in hand, by a real mouse, moved in world units from where it was pressed. */
async function grab(page: Page, x: number, y: number): Promise<{ to(dx: number, dy: number, steps?: number): Promise<void>; release(): Promise<void> }> {
  const from = await toScreen(page, x, y);
  const { s } = await cam(page);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  return {
    to: async (dx, dy, steps = 10) => page.mouse.move(from.x + dx * s, from.y + dy * s, { steps }),
    release: () => page.mouse.up(),
  };
}

/** A desk's corner in hand: its grip's target runs on into the corner, 12 in. */
async function corner(page: Page, id: string): ReturnType<typeof grab> {
  const b = (await proxy(page, id).boundingBox())!;
  const at = { x: b.x + b.width - 12, y: b.y + b.height - 12 };
  const { s } = await cam(page);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  return {
    to: async (dx, dy, steps = 10) => page.mouse.move(at.x + dx * s, at.y + dy * s, { steps }),
    release: () => page.mouse.up(),
  };
}

/** `m`, or `r`, on something on the canvas, then these keys and Enter. */
async function keyEdit(page: Page, id: string, key: string, times: number, how = 'm'): Promise<void> {
  await proxy(page, id).focus();
  await page.keyboard.press(how);
  for (let i = 0; i < times; i += 1) await page.keyboard.press(key);
  await page.keyboard.press('Enter');
}

/** A second browser: its own storage, its own tokens. */
async function secondBrowser(browser: Browser): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: test.info().project.use.baseURL });
  return ctx.newPage();
}

// ----- 1. desks never overlap

test.describe('desks never overlap, whoever saved them', () => {
  test('two clean sides that merge into an overlap: it comes out clear, one more save settles it, and both browsers land on the same places', async ({ browser, request }) => {
    const start = docOf(1, { [A]: box(0, 0, 584, 300), [B]: box(680, 400, 584, 300) });
    await harness(request, { fleet: fleet([A, B]), layoutDocs: { [ME]: start } });
    const one = await secondBrowser(browser);
    const two = await secondBrowser(browser);
    const errors = [...[one, two].map((p) => watchConsole(p))];
    for (const p of [one, two]) {
      await signIn(p);
      await canvasPainted(p);
      await p.waitForTimeout(600);
    }
    // Each move is clean where it's made: Personal along the top in one browser, Work up in the other. Together, both end at (680, 0).
    await keyEdit(one, A, 'Shift+ArrowRight', 17);
    await keyEdit(two, B, 'Shift+ArrowUp', 10);
    expect(await proxied(one, A)).toMatchObject({ x: 680, y: 0 });
    expect(await proxied(two, B)).toMatchObject({ x: 680, y: 0 });
    await expect.poll(async () => (await putsOf(request)).filter((p) => p.status === 200).length, { timeout: 10_000 }).toBe(2);
    expect((await putsOf(request)).map((p) => p.status).sort()).toEqual([200, 200, 412]);
    const up = (await saved(request))!.layout!.desks;
    expect(gapBetween(up[A]!, up[B]!)).toBeGreaterThanOrEqual(0);
    expect(up[B]).toMatchObject({ x: 680, y: 0 }); // the last to save keeps what it put there

    // The other browser reads it, has nothing to send, and is level.
    for (const p of [one, two]) await readNow(p, request);
    for (const id of [A, B]) {
      expect(await proxied(one, id), id).toMatchObject({ x: up[id]!.x, y: up[id]!.y });
      expect(await proxied(two, id), id).toMatchObject({ x: up[id]!.x, y: up[id]!.y });
    }

    // Settled: nothing passes back and forth, however many reads go by.
    const settled = (await putsOf(request)).length;
    await one.waitForTimeout(2_600);
    for (const p of [one, two]) await readNow(p, request);
    await one.waitForTimeout(2_600);
    expect((await putsOf(request)).length).toBe(settled);
    expect((await saved(request))!.version).toBe(3);
    expect(errors.flatMap(ownErrors)).toEqual([]);
    await one.context().close();
    await two.context().close();
  });

  test('a document that overlaps clears to the same places in two browsers whose own order differs, and neither saves', async ({ browser, request }) => {
    const overlapping = docOf(4, { [A]: box(0, 0, 584, 300), [B]: box(100, 50, 584, 300) });
    const clean = (z: string[]): string => JSON.stringify({ desks: { [A]: { id: A, ...box(0, 0, 584, 300), items: apps(A) }, [B]: { id: B, ...box(900, 0, 584, 300), items: apps(B) } }, z });
    await harness(request, { fleet: fleet([A, B]), layoutDocs: { [ME]: overlapping } });
    const pages = [await secondBrowser(browser), await secondBrowser(browser)];
    for (const [i, p] of pages.entries()) {
      await p.addInitScript((d) => localStorage.setItem('ma.layout.v2', d), clean(i ? [A, B] : [B, A]));
      await signIn(p);
      await canvasPainted(p);
    }
    await expect.poll(async () => {
      const [m1, m2] = [await mirrorOf(pages[0]!), await mirrorOf(pages[1]!)];
      return m1 && m2 ? [gapBetween(m1.desks[A]!, m1.desks[B]!) >= GAP - 0.011, JSON.stringify([m1.desks[A]!.x, m1.desks[A]!.y, m1.desks[B]!.x, m1.desks[B]!.y]) === JSON.stringify([m2.desks[A]!.x, m2.desks[A]!.y, m2.desks[B]!.x, m2.desks[B]!.y])] : null;
    }, { timeout: 6_000 }).toEqual([true, true]);
    await pages[0]!.waitForTimeout(2_600);
    expect(await putsOf(request)).toEqual([]);
    for (const p of pages) await p.context().close();
  });

  test('leaving with a document held back that overlaps what\'s here: what goes up is clear', async ({ page, request }) => {
    await open(page, request, [A, B], docOf(1, { [A]: box(0, 0), [B]: box(500, 0) }));
    await keyEdit(page, A, 'Shift+ArrowDown', 10); // Personal at (0, 400), unsaved
    const hand = await grab(page, 700, 100); // Work in hand, so what arrives waits
    await hand.to(0, 10, 3);
    // Another browser put Work where Personal just went.
    await harness(request, { layoutDocs: { [ME]: docOf(2, { [A]: box(0, 0), [B]: box(0, 400) }) } });
    await readNow(page, request);
    await page.goto('about:blank');
    await expect.poll(() => saved(request).then((d) => d?.version), { timeout: 3_000 }).toBe(3);
    const up = (await saved(request))!.layout!.desks;
    expect(up[A]).toMatchObject({ x: 0, y: 400 });
    expect(gapBetween(up[A]!, up[B]!)).toBeGreaterThanOrEqual(0);
  });
});

// ----- 2. stacking

test.describe('how apps are stacked follows the member, and the order of the desks doesn\'t', () => {
  test('raising an app saves on its own and reaches the other browser. Raising a desk saves nothing, and rides along with the next save', async ({ browser, request }) => {
    const start = docOf(1, { [A]: box(0, 0, 584, 236), [B]: box(700, 0, 584, 236) });
    await harness(request, { fleet: fleet([A, B]), layoutDocs: { [ME]: start } });
    const one = await secondBrowser(browser);
    const two = await secondBrowser(browser);
    for (const p of [one, two]) {
      await signIn(p);
      await canvasPainted(p);
      await p.waitForTimeout(600);
    }
    const chat = `${A}:chat`;
    await proxy(one, chat).focus(); // an app that takes keyboard focus comes to the front
    await expect.poll(() => putsOf(request).then((p) => p.length), { timeout: 6_000 }).toBe(1);
    expect((await saved(request))!.layout!.desks[A]!.stack).toEqual([`${A}:notebook`, `${A}:browser`, `${A}:agent`, chat]);
    await readNow(two, request);
    await expect.poll(() => mirrorOf(two).then((m) => m?.desks[A]!.stack), { timeout: 3_000 }).toEqual([`${A}:notebook`, `${A}:browser`, `${A}:agent`, chat]);

    // A desk raised: the order of the desks changes, and nothing goes.
    await proxy(one, B).focus();
    await one.keyboard.press('Enter');
    await expect.poll(() => mirrorOf(one).then((m) => m?.z.at(-1)), { timeout: 3_000 }).toBe(B);
    await one.waitForTimeout(2_600);
    expect((await putsOf(request)).length).toBe(1);

    // The next real change carries it, and each browser keeps its own.
    await keyEdit(one, B, 'Shift+ArrowDown', 1);
    await expect.poll(() => putsOf(request).then((p) => p.length), { timeout: 6_000 }).toBe(2);
    expect((await saved(request))!.layout!.z.at(-1)).toBe(B);
    await one.context().close();
    await two.context().close();
  });

  test('what goes up is byte for byte what came down, for a desk this browser didn\'t change, stack or none', async ({ page, request }) => {
    const stacked = { ...box(700, 0, 584, 236), stack: [`${B}:agent`, `${B}:browser`, `${B}:notebook`, `${B}:chat`] };
    const plain = box(1400, 0, 584, 236);
    const start = docOf(1, { [A]: box(0, 0, 584, 236), [B]: stacked, [C]: plain });
    await open(page, request, [A, B, C], start);
    await keyEdit(page, A, 'Shift+ArrowDown', 1);
    await expect.poll(() => putsOf(request).then((p) => p.length), { timeout: 6_000 }).toBe(1);
    const up = (await saved(request))!.layout!.desks;
    expect(JSON.stringify(up[B])).toBe(JSON.stringify(start.layout!.desks[B]));
    expect(JSON.stringify(up[C])).toBe(JSON.stringify(start.layout!.desks[C]));
    expect('stack' in up[C]!).toBe(false);
    expect('stack' in up[A]!).toBe(false); // moving a desk raises no app
    expect(up[A]!.y).toBe(40);
  });

  test('a stack arriving on its own moves no camera and re-fits nothing', async ({ page, request }) => {
    const start = docOf(1, { [A]: box(0, 0, 584, 236), [B]: box(700, 0, 584, 236) });
    await open(page, request, [A, B], start);
    const before = await cam(page);
    await page.evaluate(() => {
      const w = window as unknown as Hook & { __moves: number };
      w.__moves = 0;
      const { camera } = w.__maDesk as unknown as { camera: { onMove(fn: () => void): () => void } };
      camera.onMove(() => { w.__moves += 1; });
    });
    const next = docOf(2, { [A]: { ...box(0, 0, 584, 236), stack: [`${A}:agent`, `${A}:browser`, `${A}:notebook`, `${A}:chat`] }, [B]: box(700, 0, 584, 236) });
    await harness(request, { layoutDocs: { [ME]: next } });
    await readNow(page, request);
    await expect.poll(() => mirrorOf(page).then((m) => m?.desks[A]!.stack?.[0]), { timeout: 3_000 }).toBe(`${A}:agent`);
    expect(await cam(page)).toEqual(before);
    expect(await page.evaluate(() => (window as unknown as { __moves: number }).__moves)).toBe(0);
    await page.waitForTimeout(2_400);
    expect(await putsOf(request)).toEqual([]);
  });
});

// ----- 3. what's in progress

test.describe('what arrives waits for what\'s in progress', () => {
  // Guild is out of reach of anything these push.
  const ROW = { [A]: box(0, 0), [B]: box(500, 0), [C]: box(1600, 0) };
  // What another browser saved: Work and Guild each moved down.
  const elsewhere = (version: number): Doc => docOf(version, { [A]: box(0, 0), [B]: box(500, 700), [C]: box(1600, 700) });

  test('a desk in hand, with its neighbour pushed live: nothing moves until the drop, the drop is the member\'s, and the rest arrives', async ({ page, request }) => {
    const errors = watchConsole(page);
    await open(page, request, [A, B, C], docOf(1, ROW));
    const hand = await grab(page, 300, 100);
    await hand.to(300, 0, 12);
    const live = await nodes(page);
    expect(live[B]!.x).toBeGreaterThan(600); // being pushed, on Konva alone
    await harness(request, { layoutDocs: { [ME]: elsewhere(2) } });
    await readNow(page, request);
    await page.waitForTimeout(600);
    expect(await nodes(page)).toEqual(live);
    expect(await proxied(page, B)).toMatchObject({ x: 500, y: 0 }); // the store heard nothing
    expect(await proxied(page, C)).toMatchObject({ x: 1600, y: 0 });
    await hand.to(301, 0, 1);
    await hand.release();
    await page.waitForTimeout(100);
    // Personal, and the neighbour it pushed, are the member's. Guild wasn't touched here, so it's the other browser's.
    await expect.poll(() => proxied(page, C), { timeout: 2_000 }).toMatchObject({ x: 1600, y: 700 });
    expect(Math.abs((await proxied(page, A)).x - 300)).toBeLessThan(3); // to within the pointer's rounding, and the drag threshold
    await expect.poll(() => putsOf(request).then((p) => p.map((x) => [x.status, x.ifMatch])), { timeout: 6_000 }).toEqual([[200, '"2"']]);
    const up = (await saved(request))!.layout!.desks;
    expect(up[C]).toMatchObject({ x: 1600, y: 700 });
    expect(Math.abs(up[A]!.x - 300)).toBeLessThan(3);
    expect(gapBetween(up[A]!, up[B]!)).toBeGreaterThanOrEqual(GAP - 0.011);
    expect(gapBetween(up[B]!, up[C]!)).toBeGreaterThanOrEqual(GAP - 0.011);
    expect(ownErrors(errors)).toEqual([]);
  });

  test('a corner in hand: the same', async ({ page, request }) => {
    // Large enough on screen that the grip is there: under 290 wide, a press in the corner is the desk's.
    const wide = { [A]: box(0, 0, 584, 236), [B]: box(700, 0, 584, 236), [C]: box(1900, 0, 584, 236) };
    await open(page, request, [A, B, C], docOf(1, wide));
    const hand = await corner(page, A);
    await hand.to(200, 0, 12);
    const live = await nodes(page);
    expect(live[B]!.x).toBeGreaterThan(700);
    expect(live[A]).toEqual({ x: 0, y: 0 });
    await harness(request, { layoutDocs: { [ME]: docOf(2, { ...wide, [B]: box(700, 700, 584, 236), [C]: box(1900, 700, 584, 236) }) } });
    await readNow(page, request);
    await page.waitForTimeout(600);
    expect(await nodes(page)).toEqual(live);
    await hand.release();
    await page.waitForTimeout(100);
    await expect.poll(() => proxied(page, C), { timeout: 2_000 }).toMatchObject({ x: 1900, y: 700 });
    expect((await proxied(page, A)).w).toBeGreaterThan(700);
    await expect.poll(() => putsOf(request).then((p) => p.map((x) => [x.status, x.ifMatch])), { timeout: 6_000 }).toEqual([[200, '"2"']]);
    const up = (await saved(request))!.layout!.desks;
    expect(up[A]!.w).toBeGreaterThan(700);
    expect(up[C]).toMatchObject({ x: 1900, y: 700 });
    expect(gapBetween(up[A]!, up[B]!)).toBeGreaterThanOrEqual(GAP - 0.011);
  });

  test('an app in hand: the same', async ({ page, request }) => {
    await open(page, request, [A, B], docOf(1, { [A]: box(0, 0, 584, 236), [B]: box(700, 0, 584, 236) }));
    const chat = `${A}:chat`;
    const at = (await proxy(page, chat).boundingBox())!;
    await page.mouse.move(at.x + 20, at.y + 20);
    await page.mouse.down();
    await page.mouse.move(at.x + 60, at.y + 100, { steps: 6 });
    await harness(request, { layoutDocs: { [ME]: docOf(2, { [A]: box(0, 0, 584, 236), [B]: box(700, 500, 584, 236) }) } });
    await readNow(page, request);
    await page.waitForTimeout(600);
    expect(await proxied(page, B)).toMatchObject({ x: 700, y: 0 });
    await page.mouse.up();
    await expect.poll(() => proxied(page, B), { timeout: 2_000 }).toMatchObject({ x: 700, y: 500 });
    await expect.poll(() => putsOf(request).then((p) => p.map((x) => x.status)), { timeout: 6_000 }).toEqual([200]);
    expect((await saved(request))!.layout!.desks[A]!.items.find((i) => i.id === chat)!.y).toBeGreaterThan(24);
  });

  test('a keyboard edit: what arrives waits, Esc restores from when it began, and then the whole document lands with nothing to save', async ({ page, request }) => {
    await open(page, request, [A, B, C], docOf(1, ROW));
    await proxy(page, A).focus();
    await page.keyboard.press('m');
    for (let i = 0; i < 4; i += 1) await page.keyboard.press('Shift+ArrowRight');
    expect((await proxied(page, B)).x).toBeGreaterThan(500); // pushed
    await harness(request, { layoutDocs: { [ME]: elsewhere(2) } });
    await readNow(page, request);
    await page.waitForTimeout(600);
    expect(await proxied(page, C)).toMatchObject({ x: 1600, y: 0 });
    await page.keyboard.press('Escape');
    // Back to where it began, and that's no change of the member's, so nothing overrules what came.
    await expect.poll(() => proxied(page, B), { timeout: 2_000 }).toMatchObject({ x: 500, y: 700 });
    expect(await proxied(page, C)).toMatchObject({ x: 1600, y: 700 });
    expect(await proxied(page, A)).toMatchObject({ x: 0, y: 0 });
    await page.waitForTimeout(2_600);
    expect(await putsOf(request)).toEqual([]);
    expect((await saved(request))!.version).toBe(2);
  });

  test('a keyboard edit kept with Enter stays the member\'s, and goes on top of what came', async ({ page, request }) => {
    await open(page, request, [A, B, C], docOf(1, ROW));
    await proxy(page, A).focus();
    await page.keyboard.press('m');
    await page.keyboard.press('Shift+ArrowDown');
    await harness(request, { layoutDocs: { [ME]: elsewhere(2) } });
    await readNow(page, request);
    await page.waitForTimeout(300);
    await page.keyboard.press('Enter');
    await expect.poll(() => proxied(page, C), { timeout: 2_000 }).toMatchObject({ x: 1600, y: 700 });
    await expect.poll(() => putsOf(request).then((p) => p.map((x) => [x.status, x.ifMatch])), { timeout: 6_000 }).toEqual([[200, '"2"']]);
    const up = (await saved(request))!.layout!.desks;
    expect(up[A]).toMatchObject({ x: 0, y: 40 });
    expect(up[C]).toMatchObject({ x: 1600, y: 700 });
  });

  test('an undo that leaves nothing changed saves nothing', async ({ page, request }) => {
    const pile = { [A]: { ...box(0, 0, 800, 500), items: [item(`${A}:chat`, 'chat', 300, 200), item(`${A}:notebook`, 'notebook', 300, 200), item(`${A}:browser`, 'browser', 500, 200), item(`${A}:agent`, 'agent', 600, 300)] } };
    await open(page, request, [A], docOf(1, pile));
    const clean = page.getByRole('button', { name: 'Clean up Personal desk', exact: true });
    await clean.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Undo clean up Personal desk', exact: true }).focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2_600);
    expect(await putsOf(request)).toEqual([]);
  });

  test('cleanup\'s glide: what arrives lands after it, wherever it comes from', async ({ page, request }) => {
    const scattered = { [A]: { ...box(0, 0, 800, 500), items: [item(`${A}:chat`, 'chat', 300, 200, 200, 180), item(`${A}:notebook`, 'notebook', 40, 300), item(`${A}:browser`, 'browser', 600, 30, 90, 60), item(`${A}:agent`, 'agent', 420, 40)] }, [B]: box(900, 0, 584, 236) };
    await open(page, request, [A, B], docOf(1, scattered));
    await page.waitForTimeout(400);
    const elapsed = await page.evaluate(({ a, b, mirror }) => new Promise<number>((done) => {
      const watched = document.getElementById(`proxy-${b}`)!;
      const start = performance.now();
      new MutationObserver(() => done(performance.now() - start)).observe(watched, { attributes: true, attributeFilter: ['style'] });
      // In one task: cleanup starts its 240 ms, and another tab's copy arrives with Work somewhere else.
      document.getElementById(`proxy-cleanup:${a}`)!.click();
      window.dispatchEvent(new StorageEvent('storage', { key: 'ma.layout.v2', newValue: mirror }));
    }), { a: A, b: B, mirror: JSON.stringify({ desks: { [A]: { id: A, ...scattered[A] }, [B]: { id: B, ...box(900, 500, 584, 236), items: apps(B) } }, z: [A, B] }) });
    expect(elapsed).toBeGreaterThanOrEqual(240);
    expect(await proxied(page, B)).toMatchObject({ x: 900, y: 500 });
    const n = await nodes(page);
    expect(n[B]).toEqual({ x: 900, y: 500 }); // the node is where the store says, with no old glide left to land elsewhere
  });

  test('a menu open: what arrives waits, and lands as it closes', async ({ page, request }) => {
    await open(page, request, [A, B], docOf(1, { [A]: box(0, 0, 584, 236), [B]: box(700, 0, 584, 236) }));
    await proxy(page, A).focus();
    await page.keyboard.press('.');
    const menu = page.getByRole('menu', { name: 'Desk' });
    await expect(menu).toBeVisible();
    const camera = await cam(page);
    await harness(request, { layoutDocs: { [ME]: docOf(2, { [A]: box(0, 400, 584, 236), [B]: box(700, 0, 584, 236) }) } });
    await readNow(page, request);
    await page.waitForTimeout(600);
    await expect(menu).toBeVisible(); // a camera move would have closed it
    expect(await cam(page)).toEqual(camera);
    expect(await proxied(page, A)).toMatchObject({ x: 0, y: 0 });
    await page.keyboard.press('Escape');
    await expect.poll(() => proxied(page, A), { timeout: 2_000 }).toMatchObject({ x: 0, y: 400 });
  });

  test('a save doesn\'t wait for a menu', async ({ page, request }) => {
    await open(page, request, [A, B], docOf(1, { [A]: box(0, 0, 584, 236), [B]: box(700, 0, 584, 236) }));
    await keyEdit(page, A, 'Shift+ArrowDown', 1);
    await proxy(page, A).focus();
    await page.keyboard.press('.');
    await expect(page.getByRole('menu', { name: 'Desk' })).toBeVisible();
    await expect.poll(() => putsOf(request).then((p) => p.length), { timeout: 6_000 }).toBe(1);
    await expect(page.getByRole('menu', { name: 'Desk' })).toBeVisible();
  });

  const COVERED = [item(`${A}:chat`, 'chat', 40, 40), item(`${A}:notebook`, 'notebook', 40, 40), item(`${A}:browser`, 'browser', 300, 24), item(`${A}:agent`, 'agent', 450, 24)];
  const hiddenList = (page: Page) => page.getByRole('menu', { name: 'Hidden apps on the Personal desk' });
  const openList = async (page: Page): Promise<void> => {
    await proxy(page, `hidden:${A}`).focus();
    await page.keyboard.press('Enter');
    await expect(hiddenList(page)).toBeVisible();
  };

  test('the hidden list open: what would change it waits, and the list isn\'t pulled away', async ({ page, request }) => {
    const errors = watchConsole(page);
    await open(page, request, [A, B], docOf(1, { [A]: { ...box(0, 0, 800, 300), items: COVERED }, [B]: box(900, 0, 584, 236) }));
    await openList(page);
    // Another browser moved Chat out from under: nothing's hidden any more, and the desk moved too.
    const uncovered = COVERED.map((i) => (i.app === 'chat' ? { ...i, x: 150 } : i));
    await harness(request, { layoutDocs: { [ME]: docOf(2, { [A]: { ...box(0, 100, 800, 300), items: uncovered }, [B]: box(900, 0, 584, 236) }) } });
    await readNow(page, request);
    await page.waitForTimeout(600);
    await expect(hiddenList(page)).toBeVisible();
    await expect(hiddenList(page).getByRole('menuitem')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect.poll(() => proxied(page, A), { timeout: 2_000 }).toMatchObject({ x: 0, y: 100 });
    await expect(page.getByRole('button', { name: /^\d+ hidden apps? on the Personal desk/ })).toHaveCount(0);
    expect(ownErrors(errors)).toEqual([]);
  });

  test('choosing from the list: the raise is the member\'s, the ring plays out, and what arrived lands after it', async ({ page, request }) => {
    const errors = watchConsole(page);
    const start = { [A]: { ...box(0, 0, 800, 300), items: COVERED }, [B]: box(900, 0, 584, 236) };
    await open(page, request, [A, B], docOf(1, start));
    await openList(page);
    await harness(request, { layoutDocs: { [ME]: docOf(2, { ...start, [B]: box(900, 400, 584, 236) }) } });
    await readNow(page, request);
    await page.waitForTimeout(200);
    await page.keyboard.press('Enter');
    await expect(page.locator('.hidden-ring')).toHaveCount(1);
    expect(await proxied(page, B)).toMatchObject({ x: 900, y: 0 });
    await expect(page.locator('.hidden-ring')).toHaveCount(0, { timeout: 2_000 });
    await expect.poll(() => proxied(page, B), { timeout: 2_000 }).toMatchObject({ x: 900, y: 400 });
    await expect.poll(() => putsOf(request).then((p) => p.map((x) => [x.status, x.ifMatch])), { timeout: 6_000 }).toEqual([[200, '"2"']]);
    expect((await saved(request))!.layout!.desks[A]!.stack).toEqual([`${A}:notebook`, `${A}:browser`, `${A}:agent`, `${A}:chat`]);
    expect(ownErrors(errors)).toEqual([]);
  });

  test('a ring whose app has gone by the time it lands doesn\'t crash anything', async ({ page, request }) => {
    const errors = watchConsole(page);
    await open(page, request, [A], docOf(1, { [A]: { ...box(0, 0, 800, 300), items: COVERED } }));
    await openList(page);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(700);
    await harness(request, { layoutDocs: { [ME]: docOf(2, { [A]: { ...box(0, 0, 800, 300), items: COVERED.slice(1) } }) } });
    await page.waitForTimeout(2_000); // this browser's raise has gone up by now, as a 412 or a save
    await readNow(page, request);
    await page.waitForTimeout(400);
    expect(ownErrors(errors)).toEqual([]);
  });

  const SCATTERED = [item(`${A}:chat`, 'chat', 300, 200, 200, 180), item(`${A}:notebook`, 'notebook', 40, 300), item(`${A}:browser`, 'browser', 600, 30, 90, 60), item(`${A}:agent`, 'agent', 420, 40)];
  const cleanButton = (page: Page) => page.getByRole('button', { name: 'Clean up Personal desk', exact: true });
  const undoButton = (page: Page) => page.getByRole('button', { name: 'Undo clean up Personal desk', exact: true });
  const said = (page: Page) => page.getByRole('status').first();

  test('cleanup\'s undo, with something else arriving in its 10 s: it still works, and restores only what\'s its own', async ({ page, request }) => {
    const errors = watchConsole(page);
    await open(page, request, [A, B], docOf(1, { [A]: { ...box(0, 0, 800, 500), items: SCATTERED }, [B]: box(900, 0, 584, 236) }));
    await cleanButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(undoButton(page)).toHaveCount(1);
    await expect.poll(() => saved(request).then((d) => d?.version), { timeout: 6_000 }).toBe(2);
    const tidied = (await saved(request))!.layout!.desks[A]!;

    // Another browser moved Work. Personal is as this cleanup left it, so its object stands, and so does the undo.
    await harness(request, { layoutDocs: { [ME]: { version: 3, updatedAt: null, layout: { schemaVersion: 2, desks: { [A]: tidied, [B]: { ...box(900, 400, 584, 236), items: apps(B) } }, z: [A, B] } } } });
    await readNow(page, request);
    await expect.poll(() => proxied(page, B), { timeout: 2_000 }).toMatchObject({ x: 900, y: 400 });
    await expect(undoButton(page)).toHaveCount(1);
    await undoButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(said(page)).toHaveText('Clean up undone');
    expect(await proxied(page, `${A}:chat`)).toMatchObject({ x: 300, y: 200, w: 200, h: 180 });
    expect(await proxied(page, B)).toMatchObject({ x: 900, y: 400 }); // not put back
    await expect.poll(() => saved(request).then((d) => d?.version), { timeout: 6_000 }).toBe(4);
    const up = (await saved(request))!.layout!.desks;
    expect(up[B]).toMatchObject({ x: 900, y: 400 });
    expect(up[A]!.items.find((i) => i.app === 'chat')).toMatchObject({ x: 300, y: 200 });
    expect(ownErrors(errors)).toEqual([]);
  });

  test('cleanup\'s undo, with that desk itself changed elsewhere in its 10 s: the undo is over, not stale, and nothing crashes', async ({ page, request }) => {
    const errors = watchConsole(page);
    await open(page, request, [A, B], docOf(1, { [A]: { ...box(0, 0, 800, 500), items: SCATTERED }, [B]: box(900, 0, 584, 236) }));
    await cleanButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(undoButton(page)).toHaveCount(1);
    await expect.poll(() => saved(request).then((d) => d?.version), { timeout: 6_000 }).toBe(2);
    const tidied = (await saved(request))!.layout!.desks[A]!;
    const moved = tidied.items.map((i) => (i.app === 'chat' ? { ...i, y: 240 } : i));
    await harness(request, { layoutDocs: { [ME]: { version: 3, updatedAt: null, layout: { schemaVersion: 2, desks: { [A]: { ...tidied, items: moved }, [B]: { ...box(900, 0, 584, 236), items: apps(B) } }, z: [A, B] } } } });
    await readNow(page, request);
    await expect.poll(() => proxied(page, `${A}:chat`).then((p) => p.y), { timeout: 2_000 }).toBe(240);
    await expect(undoButton(page)).toHaveCount(0);
    // Nor does the menu offer it.
    await proxy(page, A).focus();
    await page.keyboard.press('.');
    await expect(page.getByRole('menu', { name: 'Desk' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'Undo clean up' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect((await proxied(page, `${A}:chat`)).y).toBe(240);
    await page.waitForTimeout(2_400);
    expect((await saved(request))!.version).toBe(3); // nothing to send
    expect(ownErrors(errors)).toEqual([]);
  });

  test('cleanup\'s undo, with a document landing before the save has: the desk stays the member\'s, and undo still restores it', async ({ page, request }) => {
    const errors = watchConsole(page);
    const start = { [A]: { ...box(0, 0, 800, 500), items: SCATTERED }, [B]: box(900, 0, 584, 236) };
    await open(page, request, [A, B], docOf(1, start));
    await cleanButton(page).focus();
    await page.keyboard.press('Enter');
    await harness(request, { layoutDocs: { [ME]: docOf(2, { ...start, [B]: box(900, 400, 584, 236) }) } });
    await readNow(page, request);
    await expect.poll(() => proxied(page, B), { timeout: 2_000 }).toMatchObject({ x: 900, y: 400 });
    await expect(undoButton(page)).toHaveCount(1);
    await undoButton(page).focus();
    await page.keyboard.press('Enter');
    expect(await proxied(page, `${A}:chat`)).toMatchObject({ x: 300, y: 200 });
    await page.waitForTimeout(2_600);
    expect(await putsOf(request)).toEqual([]); // back to what Platform has, so nothing to say
    expect(ownErrors(errors)).toEqual([]);
  });

  test('what Platform said isn\'t lost to another tab\'s older copy arriving while it waits', async ({ page, request }) => {
    await open(page, request, [A, B], docOf(1, { [A]: box(0, 0, 584, 236), [B]: box(700, 0, 584, 236) }));
    const hand = await grab(page, 300, 180);
    await hand.to(0, 40, 4);
    await harness(request, { layoutDocs: { [ME]: docOf(2, { [A]: box(0, 0, 584, 236), [B]: box(700, 500, 584, 236) }) } });
    await readNow(page, request);
    await page.evaluate(({ a, b }) => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'ma.layout.v2', newValue: JSON.stringify({ desks: { [a]: { id: a, x: 0, y: 0, w: 584, h: 236, items: [] }, [b]: { id: b, x: 700, y: 0, w: 584, h: 236, items: [] } }, z: [a, b] }) }));
    }, { a: A, b: B });
    await hand.release();
    await expect.poll(() => proxied(page, B), { timeout: 2_000 }).toMatchObject({ x: 700, y: 500 });
  });

  test('another tab reading this tab\'s own unsaved change doesn\'t count as it having been saved', async ({ page, request }) => {
    await open(page, request, [A, B], docOf(1, { [A]: box(0, 0, 584, 236), [B]: box(700, 0, 584, 236) }));
    await keyEdit(page, A, 'Shift+ArrowDown', 1);
    await page.waitForTimeout(1_200); // the mirror has it, and another tab has written the same back
    await page.evaluate(() => window.dispatchEvent(new StorageEvent('storage', { key: 'ma.layout.v2', newValue: localStorage.getItem('ma.layout.v2') })));
    await expect.poll(() => putsOf(request).then((p) => p.length), { timeout: 6_000 }).toBe(1);
    expect((await saved(request))!.layout!.desks[A]!.y).toBe(40);
  });
});

// ----- 4. old defaults. These are what each build's own code wrote, from running it at that commit.

test.describe('a browser still at an older default', () => {
  const generations: [string, string][] = [
    ['one row high, under the old label (1f75161)', JSON.stringify({ desks: { [A]: { id: A, x: 0, y: 36, w: 584, h: 144, items: apps(A) }, [B]: { id: B, x: 656, y: 36, w: 584, h: 144, items: apps(B) } }, z: [A, B] })],
    ['one row high, at the top (b0de92f)', JSON.stringify({ desks: { [A]: { id: A, x: 0, y: 0, w: 584, h: 144, items: apps(A) }, [B]: { id: B, x: 656, y: 0, w: 584, h: 144, items: apps(B) } }, z: [A, B] })],
    ['one old, and one a newer build added', JSON.stringify({ desks: { [A]: { id: A, x: 0, y: 0, w: 584, h: 144, items: apps(A) }, [B]: { id: B, x: 656, y: 0, w: 584, h: 236, items: apps(B) } }, z: [A, B] })],
  ];
  const ARRANGED = docOf(1, { [A]: { ...box(50, 60, 800, 500), items: [item(`${A}:chat`, 'chat', 300, 200, 200, 180), ...apps(A).slice(1)] }, [B]: box(1000, 60, 584, 236) });

  for (const [what, mirror] of generations) {
    test(`${what}: uploads nothing, even after a press, and takes the arrangement that comes`, async ({ page, request }) => {
      await open(page, request, [A, B], undefined, mirror);
      await page.waitForTimeout(2_200);
      expect(await putsOf(request)).toEqual([]);
      // Pressing an app raises it, and that's all. Still nothing to send.
      await proxy(page, `${A}:chat`).focus();
      await expect.poll(() => mirrorOf(page).then((m) => m?.desks[A]!.stack?.at(-1)), { timeout: 3_000 }).toBe(`${A}:chat`);
      await page.waitForTimeout(2_600);
      expect(await putsOf(request)).toEqual([]);
      expect(await saved(request)).toBeUndefined();
      // Now the member's arranged browser gets its turn.
      await harness(request, { layoutDocs: { [ME]: ARRANGED } });
      await readNow(page, request);
      await expect.poll(() => proxied(page, `${A}:chat`), { timeout: 2_000 }).toMatchObject({ x: 350, y: 260, w: 200, h: 180 });
      await page.waitForTimeout(2_600);
      expect(await putsOf(request)).toEqual([]);
    });
  }

  test('the old-default browser opened first, then the arranged one: the arrangement survives, in both', async ({ browser, request }) => {
    const oldDefault = generations[1]![1];
    const arranged = JSON.stringify({ desks: { [A]: { id: A, ...box(50, 60, 800, 500), items: [item(`${A}:chat`, 'chat', 300, 200, 200, 180), ...apps(A).slice(1)] }, [B]: { id: B, ...box(1000, 60, 584, 236), items: apps(B) } }, z: [A, B] });
    await harness(request, { fleet: fleet([A, B]) });
    const first = await secondBrowser(browser);
    await first.addInitScript((d) => {
      if (!localStorage.getItem('test.seeded')) localStorage.setItem('ma.layout.v2', d);
      localStorage.setItem('test.seeded', '1');
    }, oldDefault);
    await signIn(first);
    await canvasPainted(first);
    await first.waitForTimeout(2_800);
    expect(await putsOf(request)).toEqual([]);

    const second = await secondBrowser(browser);
    await second.addInitScript((d) => {
      if (!localStorage.getItem('test.seeded')) localStorage.setItem('ma.layout.v2', d);
      localStorage.setItem('test.seeded', '1');
    }, arranged);
    await signIn(second);
    await canvasPainted(second);
    await expect.poll(() => saved(request).then((d) => d?.version), { timeout: 6_000 }).toBe(1);
    expect((await saved(request))!.layout!.desks[A]).toMatchObject({ x: 50, y: 60, w: 800, h: 500 });

    await readNow(first, request);
    await expect.poll(() => proxied(first, A), { timeout: 2_000 }).toMatchObject({ x: 50, y: 60, w: 800, h: 500 });
    expect(await proxied(second, A)).toMatchObject({ x: 50, y: 60, w: 800, h: 500 });
    await first.waitForTimeout(2_600);
    expect((await putsOf(request)).length).toBe(1);
    await first.context().close();
    await second.context().close();
  });

  const NEAR_MISSES: [string, Record<string, unknown>][] = [
    ['one app moved', { desks: { [A]: { id: A, x: 0, y: 0, w: 584, h: 144, items: [{ ...apps(A)[0]!, x: 40 }, ...apps(A).slice(1)] }, [B]: { id: B, x: 656, y: 0, w: 584, h: 144, items: apps(B) } }, z: [A, B] }],
    ['one desk moved', { desks: { [A]: { id: A, x: 0, y: 0, w: 584, h: 144, items: apps(A) }, [B]: { id: B, x: 700, y: 0, w: 584, h: 144, items: apps(B) } }, z: [A, B] }],
    ['one desk resized', { desks: { [A]: { id: A, x: 0, y: 0, w: 600, h: 144, items: apps(A) }, [B]: { id: B, x: 672, y: 0, w: 584, h: 144, items: apps(B) } }, z: [A, B] }],
  ];
  for (const [what, doc] of NEAR_MISSES) {
    test(`shaped like one, with ${what}: that's a real arrangement, and it goes up`, async ({ page, request }) => {
      await open(page, request, [A, B], undefined, JSON.stringify(doc));
      await expect.poll(() => saved(request).then((d) => d?.version), { timeout: 6_000 }).toBe(1);
      const up = (await saved(request))!.layout!.desks;
      const want = doc['desks'] as Record<string, Box>;
      expect(up[A]).toMatchObject({ x: want[A]!.x, w: want[A]!.w });
      expect(up[B]).toMatchObject({ x: want[B]!.x });
    });
  }

  test('its first real change saves everything, stack and all', async ({ page, request }) => {
    await open(page, request, [A, B], undefined, generations[1]![1]);
    await proxy(page, `${A}:chat`).focus();
    await page.waitForTimeout(2_600);
    expect(await putsOf(request)).toEqual([]);
    await keyEdit(page, B, 'Shift+ArrowDown', 1);
    await expect.poll(() => putsOf(request).then((p) => p.map((x) => x.ifMatch)), { timeout: 6_000 }).toEqual(['"0"']);
    const up = (await saved(request))!.layout!.desks;
    expect(up[A]!.stack?.at(-1)).toBe(`${A}:chat`);
    expect(up[B]).toMatchObject({ x: 656, y: 40, h: 144 });
  });
});

// ----- 5. who's signed in

test.describe('whose layout it is', () => {
  const ONE = docOf(1, { [A]: box(0, 0, 584, 236) });

  test('a 401 on a read or a save follows the rule for any call: a refresh, no sign-out, no redirect, and no line of ours in the console', async ({ page, request }) => {
    const errors = watchConsole(page);
    await open(page, request, [A], ONE);
    await harness(request, { layoutFail: { status: 401, bare: 'Unauthorized' } });
    await readNow(page, request);
    await keyEdit(page, A, 'Shift+ArrowDown', 1);
    await page.waitForTimeout(3_000);
    await expect(page.locator('.ma-shell')).toBeVisible();
    await expect(page.getByTestId('sign-in')).toHaveCount(0);
    expect(new URL(page.url()).pathname).toBe('/');
    expect((await saved(request))!.version).toBe(1);
    expect((await syncRecord(page))!.dirty).toEqual([A]);
    expect(ownErrors(errors)).toEqual([]);
    // And when it mends, the next read's the next try.
    await harness(request, { layoutFail: null });
    await readNow(page, request);
    await expect.poll(() => saved(request).then((d) => d?.layout?.desks[A]!.y), { timeout: 6_000 }).toBe(40);
  });

  test('a dead session with something unsaved: it stays on record through the trip to sign in, and goes when the same member is back', async ({ page, request }) => {
    await open(page, request, [A], ONE);
    await harness(request, { layoutFail: { status: 503, method: 'PUT' }, signInHolds: true });
    await keyEdit(page, A, 'Shift+ArrowDown', 1);
    await page.waitForTimeout(2_400);
    expect((await syncRecord(page))!.dirty).toEqual([A]);
    // The next call to need a token finds the session gone, and the list acts on it, as ever.
    await harness(request, { refreshFails: true, desksUnauthorized: true });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(async () => new URL(page.url()).pathname !== '/' || await page.getByTestId('sign-in').count() > 0, { timeout: 8_000 }).toBe(true);
    expect(await syncRecord(page)).toMatchObject({ dirty: [A], member: ME });
    expect((await mirrorOf(page))!.desks[A]!.y).toBe(40);
    expect((await saved(request))!.version).toBe(1);

    await harness(request, { refreshFails: false, desksUnauthorized: false, layoutFail: null, signInHolds: false });
    await signIn(page);
    await canvasPainted(page);
    await expect.poll(() => saved(request).then((d) => d?.layout?.desks[A]!.y), { timeout: 8_000 }).toBe(40);
    expect((await saved(request))!.version).toBe(2);
    expect((await putsOf(request)).at(-1)).toMatchObject({ status: 200, user: ME, ifMatch: '"1"' });
  });

  /** Signed out of this browser as far as the app can tell, ready for whoever comes next. */
  const forgetSession = (page: Page): Promise<unknown> => page.evaluate(() => {
    localStorage.removeItem('ma-desk-web-refresh');
    sessionStorage.removeItem('ma-desk-web-refresh');
    return indexedDB.databases().then((all) => Promise.all(all.map((d) => new Promise((done) => {
      const del = indexedDB.deleteDatabase(d.name!);
      del.onsuccess = del.onerror = del.onblocked = (): void => done(null);
    }))));
  });

  test('signing in as someone else: nothing of the last member\'s goes up, and their record means nothing to the new one', async ({ page, request }) => {
    await open(page, request, [A], ONE);
    await harness(request, { layoutFail: { status: 503, method: 'PUT' } });
    await keyEdit(page, A, 'Shift+ArrowDown', 1);
    await page.waitForTimeout(2_400);
    expect(await syncRecord(page)).toMatchObject({ dirty: [A], member: ME });

    await forgetSession(page);
    await page.goto('about:blank'); // its last try goes out with the page, on its own token, and is refused too
    await harness(request, { userId: 'u-other', layoutFail: null, fleet: fleet([B]), layoutDocs: { [ME]: ONE, 'u-other': docOf(1, { [B]: box(100, 100, 584, 236) }) } });
    await signIn(page);
    await canvasPainted(page);
    await page.waitForTimeout(3_000);
    const seen = await server(request);
    expect(seen.layoutPuts.filter((p) => p.status !== 503)).toEqual([]);
    expect(seen.layoutDocs[ME]!.version).toBe(1);
    expect(seen.layoutDocs['u-other']!.version).toBe(1);
    expect(await syncRecord(page)).toMatchObject({ dirty: [], member: 'u-other' });
    expect(await proxied(page, B)).toMatchObject({ x: 100, y: 100 });
    await expect(proxy(page, A)).toHaveCount(0);
  });

  test('a new member with nothing saved: the last member\'s arrangement isn\'t theirs to upload, and when the last one comes back their document stands', async ({ page, request }) => {
    const arranged = docOf(1, { [A]: box(70, 80, 700, 300) });
    await open(page, request, [A], arranged);
    await harness(request, { layoutFail: { status: 503, method: 'PUT' } });
    await keyEdit(page, A, 'Shift+ArrowDown', 1); // unsaved, and on record
    await page.waitForTimeout(2_400);

    // Someone else, new here. Their desk is at its defaults, whatever this browser's copy said.
    await forgetSession(page);
    await page.goto('about:blank');
    await harness(request, { userId: 'u-other', layoutFail: null, fleet: fleet([B]) });
    await signIn(page);
    await canvasPainted(page);
    await page.waitForTimeout(2_800);
    expect((await server(request)).layoutDocs['u-other']).toBeUndefined();
    expect((await server(request)).layoutPuts.filter((p) => p.status !== 503)).toEqual([]);

    // The last member again, on a mirror that no longer has their desk. No default of ours replaces their document.
    await forgetSession(page);
    await page.goto('about:blank');
    await harness(request, { userId: ME, fleet: fleet([A]) });
    await signIn(page);
    await canvasPainted(page);
    await expect.poll(() => proxied(page, A), { timeout: 3_000 }).toMatchObject({ x: 70, y: 80, w: 700, h: 300 });
    await page.waitForTimeout(2_600);
    expect((await server(request)).layoutPuts.filter((p) => p.status !== 503)).toEqual([]);
    expect((await saved(request))!.version).toBe(1);
  });

  test('another tab signs in as someone else: a save here never goes out on their token, even with the version numbers level', async ({ page, request }) => {
    // Short-lived tokens, so every call asks for one, and picks up whatever's stored by then.
    await harness(request, { expiresIn: 60 });
    const theirs = docOf(1, { [B]: box(100, 100, 584, 236) });
    await open(page, request, [A], ONE);
    await keyEdit(page, A, 'Shift+ArrowDown', 1);
    // Inside the debounce, the refresh token in this browser becomes someone else's.
    await harness(request, { userId: 'u-other', layoutDocs: { [ME]: ONE, 'u-other': theirs } });
    await page.waitForTimeout(3_000);
    const seen = await server(request);
    expect(seen.layoutPuts).toEqual([]);
    expect(seen.layoutDocs['u-other']).toMatchObject({ version: 1 });
    expect(seen.layoutDocs[ME]).toMatchObject({ version: 1 });
    // Their desks come with the next list, and from there this tab is theirs, and level with their document.
    await harness(request, { fleet: fleet([B]) });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => proxied(page, B).catch(() => null), { timeout: 4_000 }).toMatchObject({ x: 100, y: 100 });
    expect(await syncRecord(page)).toMatchObject({ dirty: [], member: 'u-other' });
    await page.waitForTimeout(2_600);
    expect((await server(request)).layoutPuts).toEqual([]);
    expect((await server(request)).layoutDocs['u-other']).toMatchObject({ version: 1 });
  });

  test('a read that crossed a change of member is dropped, and the next one is theirs', async ({ page, request }) => {
    await harness(request, { expiresIn: 60 });
    await open(page, request, [A], ONE);
    // What the last member's read will say, which would show if it landed.
    await harness(request, { layoutDocs: { [ME]: docOf(2, { [A]: box(5, 5, 584, 236) }) } });
    let open_ = (): void => {};
    const gate = new Promise<void>((done) => { open_ = done; });
    let asked = false;
    await page.route('**/v1/me/desk-layout', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      const res = await route.fetch();
      asked = true;
      await gate;
      return route.fulfill({ response: res });
    });
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await expect.poll(() => asked, { timeout: 3_000 }).toBe(true);
    // While that's on its way back, this browser's token becomes someone else's, and a save here finds out.
    await harness(request, { userId: 'u-other', layoutDocs: { [ME]: docOf(2, { [A]: box(5, 5, 584, 236) }), 'u-other': docOf(3, { [B]: box(100, 100, 584, 236) }) } });
    await keyEdit(page, A, 'Shift+ArrowDown', 1);
    await page.waitForTimeout(2_600);
    open_();
    await expect.poll(() => syncRecord(page).then((r) => [r?.member, r?.dirty]), { timeout: 4_000 }).toEqual(['u-other', []]);
    expect(await proxied(page, A)).toMatchObject({ x: 0, y: 40 }); // what the dropped answer said never landed
    const seen = await server(request);
    expect(seen.layoutPuts).toEqual([]);
    expect(seen.layoutDocs[ME]!.version).toBe(2);
    expect(seen.layoutDocs['u-other']!.version).toBe(3);
    await page.unrouteAll({ behavior: 'wait' });
  });

  test('sign-out with something unsaved: it goes under this member first, then nothing more', async ({ page, request }) => {
    await open(page, request, [A], ONE);
    await keyEdit(page, A, 'Shift+ArrowDown', 1);
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect.poll(() => saved(request).then((d) => d?.layout?.desks[A]!.y), { timeout: 4_000 }).toBe(40);
    expect((await putsOf(request)).map((p) => p.user)).toEqual([ME]);
  });
});

// ----- 6. the contract

test.describe('the fake route answers as `services/identity` does', () => {
  const TOKEN = (sub: string): string => {
    const part = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');
    return `${part({ alg: 'none' })}.${part({ token_use: 'access', sub, exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
  };
  const URL_ = '/v1/me/desk-layout';
  const doc = (extra: Record<string, unknown> = {}): { layout: Record<string, unknown> } => ({ layout: { schemaVersion: 2, desks: {}, z: [], ...extra } });
  const auth = (sub = 'u-a'): Record<string, string> => ({ Authorization: `Bearer ${TOKEN(sub)}` });

  test('reads, saves, ETags and every refusal', async ({ request }) => {
    const never = await request.get(URL_, { headers: { ...auth(), 'If-None-Match': '"0"' } });
    expect(never.status()).toBe(200); // never a 304
    expect(never.headers()['etag']).toBe('"0"');
    expect(never.headers()['cache-control']).toBe('no-store');
    expect(await never.json()).toEqual({ version: 0, updatedAt: null, layout: null });

    const put = (ifMatch: string | undefined, body: unknown, sub = 'u-a') => request.put(URL_, { headers: { ...auth(sub), 'Content-Type': 'application/json', ...(ifMatch === undefined ? {} : { 'If-Match': ifMatch }) }, data: typeof body === 'string' ? body : JSON.stringify(body) });

    const first = await put('"0"', doc());
    expect(first.status()).toBe(200);
    expect(first.headers()['etag']).toBe('"1"');
    expect(await first.json()).toMatchObject({ version: 1, layout: doc().layout });

    const code = async (r: Awaited<ReturnType<typeof put>>): Promise<[number, string]> => [r.status(), ((await r.json()) as { error: { code: string } }).error.code];
    expect(await code(await put(undefined, doc()))).toEqual([428, 'precondition_required']);
    expect(await code(await put('', doc()))).toEqual([428, 'precondition_required']);
    for (const bad of ['*', '1', 'W/"1"', '"01"', '"1', '"-1"']) expect(await code(await put(bad, doc())), bad).toEqual([400, 'invalid_request']);

    const stale = await put('"0"', doc());
    expect(stale.status()).toBe(412);
    expect((await stale.json()) as unknown).toMatchObject({ error: { code: 'version_mismatch', retryable: false, details: { currentVersion: 1 } } });

    for (const body of ['not json', '[]', 'null', {}, { layout: null }, { layout: [] }, { layout: 'x' }, { layout: {} }, { layout: { schemaVersion: 0 } }, { layout: { schemaVersion: 1.5 } }]) {
      expect(await code(await put('"1"', body)), JSON.stringify(body)).toEqual([400, 'invalid_request']);
    }

    // Exactly 64 KiB of serialized layout is fine, and one more byte isn't.
    const base = Buffer.byteLength(JSON.stringify(doc({ pad: '' }).layout));
    const atLimit = await put('"1"', doc({ pad: 'x'.repeat(64 * 1024 - base) }));
    expect(atLimit.status()).toBe(200);
    const over = await put('"2"', doc({ pad: 'x'.repeat(64 * 1024 - base + 1) }));
    expect(await over.json()).toMatchObject({ error: { code: 'invalid_request', details: { maxBytes: 64 * 1024 } } });
    expect(over.status()).toBe(413);

    // One member's document is theirs alone.
    const other = await request.get(URL_, { headers: auth('u-b') });
    expect(await other.json()).toMatchObject({ version: 0, layout: null });
    expect((await request.get(URL_)).status()).toBe(401);
    expect(await (await request.get(URL_)).json()).toEqual({ message: 'Unauthorized' });
  });

  test('60 saves in a calendar minute per member, counting a 412 and not a 400, 413 or 428, with Retry-After for what\'s left of it', async ({ request }) => {
    const left = 60 - new Date().getUTCSeconds();
    if (left < 20) await new Promise((done) => setTimeout(done, (left + 1) * 1000));
    const put = (ifMatch: string | undefined, body: unknown, sub = 'u-a') => request.put(URL_, { headers: { ...auth(sub), 'Content-Type': 'application/json', ...(ifMatch === undefined ? {} : { 'If-Match': ifMatch }) }, data: JSON.stringify(body) });
    expect((await put(undefined, doc())).status()).toBe(428);
    expect((await put('*', doc())).status()).toBe(400);
    expect((await put('"0"', { layout: {} })).status()).toBe(400);
    expect((await put('"0"', doc({ pad: 'x'.repeat(70_000) }))).status()).toBe(413);
    for (let i = 0; i < 59; i += 1) expect((await put(`"${i}"`, doc({ i }))).status(), `save ${i}`).toBe(200);
    expect((await put('"999"', doc())).status()).toBe(412);
    const limited = await put('"59"', doc());
    expect(limited.status()).toBe(429);
    expect(await limited.json()).toMatchObject({ error: { code: 'rate_limited', retryable: true } });
    const retry = Number(limited.headers()['retry-after']);
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(60);
    // A refusal for the body or If-Match still comes first, and another member isn't touched.
    expect((await put(undefined, doc())).status()).toBe(428);
    expect((await put('"0"', doc(), 'u-b')).status()).toBe(200);
  });
});

test.describe('what the route can say', () => {
  const ONE = docOf(1, { [A]: box(0, 0, 584, 236) });

  test('API Gateway\'s own 429 has only `message` and no Retry-After: it backs off, and the save still goes', async ({ page, request }) => {
    const errors = watchConsole(page);
    await open(page, request, [A], ONE);
    await harness(request, { layoutFail: { status: 429, bare: 'Too Many Requests', method: 'PUT', times: 1 } });
    await keyEdit(page, A, 'Shift+ArrowDown', 1);
    await expect.poll(() => putsOf(request).then((p) => p.map((x) => x.status)), { timeout: 10_000 }).toEqual([429, 200]);
    const [first, second] = await putsOf(request);
    expect(second!.at - first!.at).toBeGreaterThanOrEqual(1_500); // 2 s, less the jitter
    expect(ownErrors(errors)).toEqual([]);
  });

  test('a desk the document has and the list hasn\'t heard of yet: it stays out, then lands where the document says, with no save', async ({ page, request }) => {
    await open(page, request, [A], docOf(1, { [A]: box(0, 0, 584, 236) }));
    await harness(request, { layoutDocs: { [ME]: docOf(2, { [A]: box(0, 0, 584, 236), [B]: box(150, 600, 700, 300) }) } });
    await readNow(page, request);
    await page.waitForTimeout(300);
    await expect(proxy(page, B)).toHaveCount(0);
    await harness(request, { fleet: fleet([A, B]) });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect.poll(() => proxied(page, B).catch(() => null), { timeout: 3_000 }).toMatchObject({ x: 150, y: 600, w: 700, h: 300 });
    await page.waitForTimeout(2_600);
    expect(await putsOf(request)).toEqual([]);
    // So the next save carries it as it is, and doesn't put a default in its place.
    await keyEdit(page, A, 'Shift+ArrowDown', 1);
    await expect.poll(() => saved(request).then((d) => d?.version), { timeout: 6_000 }).toBe(3);
    expect((await saved(request))!.layout!.desks[B]).toMatchObject({ x: 150, y: 600, w: 700, h: 300 });
  });

  test('a document a test script left, with no desks, wipes nothing here', async ({ page, request }) => {
    const left = JSON.stringify({ desks: { [A]: { id: A, ...box(70, 80, 700, 300), items: apps(A) } }, z: [A] });
    await open(page, request, [A], { version: 4, updatedAt: null, layout: { schemaVersion: 2, desks: {}, z: ['one'], label: 'whatever' } as unknown as Saved }, left);
    expect(await proxied(page, A)).toMatchObject({ x: 70, y: 80 });
    await keyEdit(page, A, 'Shift+ArrowDown', 1);
    await expect.poll(() => saved(request).then((d) => d?.version), { timeout: 6_000 }).toBe(5);
    const up = (await saved(request))!.layout! as unknown as Saved & { label: string };
    expect(up.desks[A]).toMatchObject({ x: 70, y: 120 });
    expect(up.label).toBe('whatever'); // fields it doesn't know go back as they came
  });
});
