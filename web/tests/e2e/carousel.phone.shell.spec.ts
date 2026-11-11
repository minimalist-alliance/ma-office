// The carousel on a phone (the Product Designer's option 3, "Thumb row"; the launch demo's clip 3 opens on it): a tap on
// an app's tile opens it full screen in the desk's carousel, over a 56 px row of the desk's app glyphs (a tablist, the
// shown one marked in accent) with "Back to the desk" at its right end. A glyph or a swipe along the row moves; a finger
// on the Browser's picture stays the page's. The same `desks[<id>].carousel` as a larger screen's, both ways. By CDP
// touch on MockDeskLink, at 390 x 844 and 360 x 780.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type CDPSession, type Locator, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const PERSONAL = 'd-personal00001';
const WORK = 'd-work000000001';
const ME = 'u-test';
const fleet = [
  { deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' },
  { deskId: WORK, name: 'Work', kind: 'work', state: 'running' },
];
const PHONES = [{ width: 390, height: 844 }, { width: 360, height: 780 }];

type Hook = { __maDesk: { camera: { isMoving(): boolean } } };
interface MockControl { rpc: { m: string; p: Record<string, unknown> }[] }
interface Saved { layout: { desks: Record<string, { carousel?: { on: boolean; app: string } }> } | null }

const desk = (page: Page, name = 'Personal'): Locator => page.getByRole('group', { name: `${name} desk` });
const tile = (page: Page, app: string): Locator => desk(page).getByRole('button', { name: new RegExp(`^${app}`) });
const stage = (page: Page): Locator => page.getByTestId('carousel-stage');
const slide = (page: Page): Locator => page.locator('.carousel-slide:not(.leaving)');
const row = (page: Page): Locator => page.getByTestId('carousel-thumbs');
const tabs = (page: Page): Locator => stage(page).getByRole('tablist', { name: 'Apps' });
const tab = (page: Page, app: string): Locator => tabs(page).getByRole('tab', { name: app, exact: true });
const said = (page: Page): Locator => page.getByTestId('live-region');
const streamCalls = (page: Page): Promise<string[]> =>
  page.evaluate(() => (window as unknown as { __maDeskMock: MockControl }).__maDeskMock.rpc.filter((r) => r.m === 'browser.stream.set').map((r) => r.p['state'] as string));
/** What this browser keeps of the layout document, the copy it sends to Platform. */
const local = (page: Page): Promise<{ desks: Record<string, { carousel?: unknown }> } | null> => page.evaluate(() => JSON.parse(localStorage.getItem('ma.layout.v2') ?? 'null'));
const saved = async (request: APIRequestContext): Promise<Saved | undefined> => ((await (await request.get('/__harness')).json()) as { layoutDocs: Record<string, Saved | undefined> }).layoutDocs[ME];

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(250);
}

/** Two desks from the harness's list and the Personal desk in front, as a phone shows it: its grid of tiles. */
async function arrive(page: Page, request: APIRequestContext, theme: ThemeId = 'light', path = '/'): Promise<void> {
  await setTheme(page, theme);
  await harness(request, { fleet });
  await signIn(page, path);
  await canvasPainted(page);
  await focusCanvas(page);
  await page.keyboard.press('1');
  await settled(page);
}

/** A finger's tap in the middle of what the locator covers. */
async function tap(page: Page, l: Locator): Promise<void> {
  const b = (await l.boundingBox())!;
  await page.touchscreen.tap(b.x + b.width / 2, b.y + b.height / 2);
}

/**
 * Nothing about a phone's carousel is saved: past the layout's save delay (2 s), neither Platform's copy nor this browser's
 * has a `carousel` on the desk.
 */
async function nothingSaved(page: Page, request: APIRequestContext): Promise<void> {
  await page.waitForTimeout(3_000);
  expect((await saved(request))?.layout?.desks[PERSONAL]?.carousel).toBeUndefined();
  expect((await local(page))?.desks[PERSONAL]?.carousel).toBeUndefined();
}

/** A tap on an app's tile, on the canvas where its proxy says it is. */
async function openFromTile(page: Page, app: string): Promise<void> {
  await tap(page, tile(page, app));
  await expect(stage(page)).toBeVisible();
  await expect(slide(page)).toHaveAttribute('aria-label', new RegExp(`^${app}, \\d of \\d$`));
}

/** A finger's sideways swipe, from a point, through CDP as a touch screen sends it. */
async function swipe(cdp: CDPSession, from: { x: number; y: number }, dx: number): Promise<void> {
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: from.x, y: from.y }] });
  for (let i = 1; i <= 6; i += 1) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: from.x + (dx * i) / 6, y: from.y + i / 2 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

const middle = async (l: Locator): Promise<{ x: number; y: number }> => {
  const b = (await l.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};

async function axe(page: Page, rules: Record<string, { enabled: boolean }> = {}): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async (r) => {
    interface Rule { id: string; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const res = await w.axe.run({ include: ['.carousel-stage'] }, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] },
      resultTypes: ['violations'],
      rules: r,
    });
    return res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  }, rules);
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

for (const size of PHONES) {
  test.describe(`a ${size.width} x ${size.height} phone`, () => {
    test.use({ viewport: size, hasTouch: true, isMobile: true });

    test('a tile opens its app full screen over the thumb row, and a glyph or a swipe along the row moves it', async ({ page, request }) => {
      const errors = watchConsole(page);
      await arrive(page, request);
      // The desk is as it was: its tiles, and no stage.
      await expect(stage(page)).toHaveCount(0);
      await expect(tile(page, 'Notebook')).toHaveCount(1);

      await openFromTile(page, 'Notebook');
      await expect(said(page)).toHaveText(/^Notebook, 2 of \d$/);
      // Full screen, as a window is on a phone, and it has the keyboard.
      expect(await stage(page).boundingBox()).toEqual({ x: 0, y: 0, ...size });
      await expect(stage(page)).toBeFocused();
      await expect(stage(page)).toHaveAttribute('aria-modal', 'true');
      // The app's own head: the back arrow, its name and the desk's.
      await expect(slide(page).getByRole('heading', { name: 'Notebook Personal' })).toBeVisible();
      await expect(slide(page).getByRole('button', { name: 'Back from Notebook' })).toBeVisible();
      // The row: 56 px at the bottom, a tab per app with the shown one selected, and the way back at its right end.
      const r = (await row(page).boundingBox())!;
      expect(r).toEqual({ x: 0, y: size.height - 56, width: size.width, height: 56 });
      const count = await tabs(page).getByRole('tab').count();
      expect(count).toBeGreaterThanOrEqual(4);
      await expect(tab(page, 'Notebook')).toHaveAttribute('aria-selected', 'true');
      await expect(tabs(page).getByRole('tab', { selected: true })).toHaveCount(1);
      const back = stage(page).getByRole('button', { name: 'Back to the desk' });
      const bb = (await back.boundingBox())!;
      expect(bb.x + bb.width).toBeLessThanOrEqual(size.width);
      expect(bb.x + bb.width).toBeGreaterThan(size.width - 20);
      expect(bb.y).toBeGreaterThanOrEqual(r.y);
      // A finger's size, every one, and every glyph on screen left of the way back.
      expect(bb.width).toBeGreaterThanOrEqual(44);
      expect(bb.height).toBeGreaterThanOrEqual(44);
      for (const b of await tabs(page).getByRole('tab').all()) {
        const box = (await b.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(44);
        expect(box.height).toBeGreaterThanOrEqual(44);
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(bb.x);
      }
      // The app gets the rest: the slide runs from the top to the row.
      const sl = (await slide(page).boundingBox())!;
      expect(sl.y).toBe(0);
      expect(sl.y + sl.height).toBe(r.y);

      // A tap on a glyph goes straight there, and the marker follows it.
      await tap(page, tab(page, 'Browser'));
      await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, 3 of \d$/);
      await expect(tab(page, 'Browser')).toHaveAttribute('aria-selected', 'true');
      await expect(tab(page, 'Notebook')).toHaveAttribute('aria-selected', 'false');
      await expect(said(page)).toHaveText(/^Browser, 3 of \d$/);
      expect(await page.locator('.thumb-mark').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0.22s');
      await expect.poll(async () => {
        const m = (await page.locator('.thumb-mark').boundingBox())!;
        const t = (await tab(page, 'Browser').boundingBox())!;
        return Math.round(m.x + m.width / 2 - (t.x + t.width / 2));
      }).toBe(0);

      // Only the app on show is live: the Browser streams while it shows (and asks off below, swiped away).
      await expect.poll(async () => (await streamCalls(page)).at(-1)).toBe('live');
      await expect(page.getByTestId('browser-app')).toHaveCount(1);
      // A finger on the Browser's picture is the page's, sideways included.
      const cdp = await page.context().newCDPSession(page);
      await expect(page.getByTestId('browser-video')).toBeVisible();
      await page.waitForTimeout(300);
      await swipe(cdp, await middle(page.getByTestId('browser-video')), -160);
      await page.waitForTimeout(400);
      await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, 3 of \d$/);

      // A swipe along the row moves one app: to the left is the next, as the app follows the finger.
      const along = { x: size.width / 2, y: r.y + r.height / 2 };
      await swipe(cdp, along, -160);
      await expect(slide(page)).toHaveAttribute('aria-label', /^Agent, 4 of \d$/);
      await expect(tab(page, 'Agent')).toHaveAttribute('aria-selected', 'true');
      await expect.poll(async () => (await streamCalls(page)).at(-1)).toBe('off');
      await expect(page.getByTestId('browser-app')).toHaveCount(0);
      await page.waitForTimeout(300);
      await swipe(cdp, along, 160);
      await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, 3 of \d$/);
      await page.waitForTimeout(300);
      // And from the head, which is off the picture.
      await swipe(cdp, { x: size.width / 2, y: 22 }, 160);
      await expect(slide(page)).toHaveAttribute('aria-label', /^Notebook, 2 of \d$/);
      // Only the shown app is mounted, and it stays the one shown: no wrap past the first.
      await page.waitForTimeout(300);
      await expect(page.locator('.carousel-slide')).toHaveCount(1);
      // A tap just after a quick swipe stops what the swipe set going rather than pressing, as on any touch screen.
      await page.waitForTimeout(1200);
      await tap(page, tab(page, 'Chat'));
      await expect(slide(page)).toHaveAttribute('aria-label', /^Chat, 1 of \d$/);
      await page.waitForTimeout(300);
      await swipe(cdp, along, 160);
      await page.waitForTimeout(300);
      await expect(slide(page)).toHaveAttribute('aria-label', /^Chat, 1 of \d$/);
      expect(errors).toEqual([]);
    });

    test('back to the desk from the row\'s button, the head\'s arrow and Esc, each to that app\'s tile', async ({ page, request }) => {
      const errors = watchConsole(page);
      await arrive(page, request);
      await openFromTile(page, 'Notebook');
      await tap(page, stage(page).getByRole('button', { name: 'Back to the desk' }));
      await expect(stage(page)).toHaveCount(0);
      await expect(tile(page, 'Notebook')).toBeFocused();
      // A phone's carousel is how its apps open, and its own: nothing of it reaches the layout.
      await nothingSaved(page, request);

      await openFromTile(page, 'Agent');
      await tap(page, slide(page).getByRole('button', { name: 'Back from Agent' }));
      await expect(stage(page)).toHaveCount(0);
      await expect(tile(page, 'Agent')).toBeFocused();

      // A keyboard on the phone: Esc goes back to the desk from the app, as from a window there. Arrows on the row move.
      await openFromTile(page, 'Chat');
      await tab(page, 'Chat').focus();
      await page.keyboard.press('ArrowRight');
      await expect(slide(page)).toHaveAttribute('aria-label', /^Notebook, 2 of \d$/);
      await expect(tab(page, 'Notebook')).toBeFocused();
      await page.keyboard.press('End');
      await expect(tabs(page).getByRole('tab').last()).toBeFocused();
      await expect(tabs(page).getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
      await page.keyboard.press('Home');
      await expect(slide(page)).toHaveAttribute('aria-label', /^Chat, 1 of \d$/);
      await page.keyboard.press('Escape');
      await expect(stage(page)).toHaveCount(0);
      await expect(tile(page, 'Chat')).toBeFocused();
      // The other desk never heard of it.
      expect((await saved(request))?.layout?.desks[WORK]?.carousel).toBeUndefined();
      expect(errors).toEqual([]);
    });
  });
}

test.describe('a phone and a larger screen', () => {
  test.use({ viewport: PHONES[0]!, hasTouch: true, isMobile: true });

  test('a phone never writes the desk\'s carousel, and opens on a larger screen\'s only as a convenience', async ({ page, request, browser, baseURL }) => {
    const errors = watchConsole(page);
    await arrive(page, request);
    await openFromTile(page, 'Notebook');
    await tap(page, tab(page, 'Browser'));
    await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, 3 of \d$/);
    await nothingSaved(page, request);
    // A reload in this tab keeps the phone's own app.
    await page.reload();
    await canvasPainted(page);
    await settled(page);
    await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, 3 of \d$/);

    // The laptop finds the desk exactly as it was, not in carousel.
    const laptop = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
    const big = await laptop.newPage();
    await setTheme(big, 'light');
    await signIn(big);
    await canvasPainted(big);
    await focusCanvas(big);
    await big.keyboard.press('1');
    await settled(big);
    const toggle = desk(big).getByRole('button', { name: /^(Carousel|Back to the desk)$/ });
    await expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await expect(stage(big)).toHaveCount(0);
    // Its own carousel, on Agent.
    await toggle.focus();
    await big.keyboard.press('Enter');
    await settled(big);
    await big.keyboard.press('ArrowRight');
    await big.keyboard.press('ArrowRight');
    await big.keyboard.press('ArrowRight');
    await expect(slide(big)).toHaveAttribute('aria-label', /^Agent, 4 of \d$/);
    await expect.poll(async () => (await saved(request))?.layout?.desks[PERSONAL]?.carousel, { timeout: 15_000 }).toEqual({ on: true, app: 'agent' });

    // The phone that chose for itself keeps its choice in this tab.
    await page.reload();
    await canvasPainted(page);
    await settled(page);
    await expect(slide(page)).toHaveAttribute('aria-label', /^Browser, 3 of \d$/);

    // A new visit on a phone opens on the laptop's app, as a convenience, and what it does there stays on the phone.
    const phone2 = await browser.newContext({ baseURL, viewport: PHONES[0]!, hasTouch: true, isMobile: true });
    const small = await phone2.newPage();
    await setTheme(small, 'light');
    await signIn(small);
    await canvasPainted(small);
    await focusCanvas(small);
    await small.keyboard.press('1');
    await settled(small);
    await expect(slide(small)).toHaveAttribute('aria-label', /^Agent, 4 of \d$/);
    await expect(tab(small, 'Agent')).toHaveAttribute('aria-selected', 'true');
    await tap(small, tab(small, 'Chat'));
    await expect(slide(small)).toHaveAttribute('aria-label', /^Chat, 1 of \d$/);
    await tap(small, stage(small).getByRole('button', { name: 'Back to the desk' }));
    await expect(stage(small)).toHaveCount(0);
    await small.waitForTimeout(3_000);
    expect((await saved(request))?.layout?.desks[PERSONAL]?.carousel).toEqual({ on: true, app: 'agent' });
    // And the laptop's desk is still as it left it.
    await big.reload();
    await canvasPainted(big);
    await settled(big);
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(slide(big)).toHaveAttribute('aria-label', /^Agent, 4 of \d$/);
    await phone2.close();
    await laptop.close();
    expect(errors).toEqual([]);
  });
});

test.describe('on a 390 x 844 phone', () => {
  test.use({ viewport: PHONES[0]!, hasTouch: true, isMobile: true });

  test('with the on-screen keyboard up for the Notebook\'s page, the row steps aside, and comes back as it goes', async ({ page, request }) => {
    const errors = watchConsole(page);
    await arrive(page, request);
    await openFromTile(page, 'Notebook');
    const editor = page.locator('.carousel-slide .ProseMirror').first();
    await tap(page, editor);
    await expect(editor).toBeFocused();
    // No keyboard yet (a hardware one, or none): the row stays.
    await expect(row(page)).toBeVisible();
    // The keyboard comes up: the visible page is 330 px shorter, as a phone's is.
    const keyboard = (up: boolean): Promise<void> => page.evaluate((u) => {
      const vv = window.visualViewport!;
      if (u) Object.defineProperty(vv, 'height', { configurable: true, get: () => window.innerHeight - 330 });
      else delete (vv as unknown as Record<string, unknown>)['height'];
      vv.dispatchEvent(new Event('resize'));
    }, up);
    await keyboard(true);
    await expect(row(page)).toBeHidden();
    // The page gets the room.
    const sl = (await slide(page).boundingBox())!;
    expect(sl.y + sl.height).toBe(844);
    await page.keyboard.type('Packing list');
    await expect(editor).toContainText('Packing list');
    await keyboard(false);
    await expect(row(page)).toBeVisible();
    // Up again, and the focus leaves the page for the head: nothing's typing, so the row is back.
    await keyboard(true);
    await expect(row(page)).toBeHidden();
    await slide(page).getByRole('button', { name: 'Back from Notebook' }).focus();
    await expect(row(page)).toBeVisible();
    await keyboard(false);
    expect(errors).toEqual([]);
  });

  test('the apps slide and the marker slides with them; under reduced motion both are instant', async ({ page, request }) => {
    await arrive(page, request, 'light', '/?slideMs=3000');
    await openFromTile(page, 'Notebook');
    await page.waitForTimeout(300);
    await tap(page, tab(page, 'Browser'));
    // Mid-slide: the one leaving is still there, inert, beside the one coming in; the marker takes the slide's time
    // (3 s here, slowed for the look; 220 ms otherwise), so it's on its way too.
    await expect(page.locator('.carousel-slide.leaving')).toHaveCount(1);
    await expect(page.locator('.carousel-slide.leaving')).toHaveAttribute('inert', '');
    expect(await page.locator('.thumb-mark').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('3s');
    const [from, to] = [(await tab(page, 'Notebook').boundingBox())!, (await tab(page, 'Browser').boundingBox())!];
    const markerX = async (): Promise<number> => (await page.locator('.thumb-mark').boundingBox())!.x;
    await expect.poll(markerX).toBeGreaterThan(from.x + 2);
    expect(await markerX()).toBeLessThan(to.x - 2);
    await expect(page.locator('.carousel-slide.leaving')).toHaveCount(0, { timeout: 6_000 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await tap(page, tab(page, 'Agent'));
    await expect(slide(page)).toHaveAttribute('aria-label', /^Agent, 4 of \d$/);
    await expect(page.locator('.carousel-slide')).toHaveCount(1);
    expect(await page.locator('.thumb-mark').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
  });

  test('the row keeps clear of the home indicator', async ({ page, request }) => {
    await arrive(page, request);
    await openFromTile(page, 'Chat');
    // Chromium has no notch to stand in for one, so this reads the rule: the row grows by the bottom inset and pads it.
    const rule = await page.evaluate(() => {
      for (const sheet of [...document.styleSheets]) {
        let rules: CSSRuleList;
        try {
          rules = sheet.cssRules;
        } catch {
          continue;
        }
        for (const r of [...rules]) if (r instanceof CSSStyleRule && r.selectorText === '.carousel-thumbs') return { height: r.style.height, padding: r.style.paddingBottom };
      }
      return null;
    });
    expect(rule?.height).toContain('safe-area-inset-bottom');
    expect(rule?.padding).toContain('safe-area-inset-bottom');
  });

  for (const theme of ['light', 'dark'] as ThemeId[]) {
    test(`axe at WCAG 2.2 AA on the phone's carousel, ${theme}`, async ({ page, request }) => {
      await arrive(page, request, theme);
      await openFromTile(page, 'Chat');
      await page.waitForTimeout(400);
      expect(await axe(page)).toEqual([]);
      await tap(page, tab(page, 'Notebook'));
      await expect(slide(page)).toHaveAttribute('aria-label', /^Notebook, 2 of \d$/);
      await page.waitForTimeout(600);
      // An empty title in the editor is where the title goes, with its placeholder (as in notebook.shell.spec.ts).
      expect(await axe(page, { 'empty-heading': { enabled: false } })).toEqual([]);
    });
  }
});
