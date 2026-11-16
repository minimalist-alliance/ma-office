// A brand-new member's first office (the owner, Nov 12; ADR 0057): nothing saved, no layout and no camera. "When I first
// went to test＠'s office, the desk is unnaturally dimensioned and too small so everything is super zoomed in and kind of
// ugly." The rule: "By default when a desk is first introduced I want it to be only 50% of a browser's width in a 16:9
// layout. 4:3 and others are obviously different". So the desk is naturally proportioned (16:10 to 2:1), half the width
// of a 16:9 screen, the same share of the area on any other ((2/3)·√(W·H) wide), centred between the bars, near 100 % on
// laptop and desktop screens, and whole on screen. A phone keeps its own fit: the cell grid across its width. Only a
// desk as the office introduced it (860 x 480) is framed so: a saved desk the member arranged keeps its size and its
// framing, filling the screen up to 175 % as before, and so does a new desk once the member resizes it.
// With FIRST_OFFICE_SHOTS naming a folder, it also writes the review shots, in Light, Zen and Dark, named by
// FIRST_OFFICE_LABEL (`before` on main, `after` here).
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

declare const __maDesk: { camera: { cam: { x: number; y: number; s: number }; isMoving(): boolean } };

const ME = 'u-test';
const ID = 'd-personal00001';
const ADDED = 'd-work000000001';
const SHOTS = process.env['FIRST_OFFICE_SHOTS'];
const LABEL = process.env['FIRST_OFFICE_LABEL'] ?? 'after';
const THEMES: [ThemeId, string][] = [['light', 'light'], ['dusk', 'zen'], ['dark', 'dark']];

interface Screen { name: string; w: number; h: number; dpr: number; phone?: boolean; short?: boolean }
const SCREENS: Screen[] = [
  { name: '1920x1080', w: 1920, h: 1080, dpr: 1 },
  { name: '1440x900', w: 1440, h: 900, dpr: 1 },
  { name: '1024x768', w: 1024, h: 768, dpr: 1 },
  { name: '3440x1440', w: 3440, h: 1440, dpr: 1 },
  { name: '2880x1800', w: 2880, h: 1800, dpr: 1 },
  { name: '1440x900-dpr2', w: 1440, h: 900, dpr: 2 }, // a 2880 x 1800 Retina panel: 1440 x 900 CSS px
  { name: '390x844', w: 390, h: 844, dpr: 3, phone: true },
  { name: '844x390', w: 844, h: 390, dpr: 3, short: true }, // a phone on its side: the bars' short-viewport mode
];
/** The short-viewport mode's bars (under 400 px high): 52 px at the top, 60 at the foot. */
const SHORT_BARS = { top: 52, bottom: 60 };

type Box = { x: number; y: number; width: number; height: number };

const fleet = (ids: [string, string, string][]) => ids.map(([deskId, name, kind]) => ({ deskId, name, kind, state: 'running' }));

/** The office as a first visit has it: Platform's list with one desk and no saved layout; Files on, as in prod. */
async function firstVisit(page: Page, request: APIRequestContext, layoutDocs?: Record<string, unknown>): Promise<void> {
  await harness(request, { reset: true });
  await harness(request, { fleet: fleet([[ID, 'Personal', 'personal']]), files: { enabled: true }, ...(layoutDocs ? { layoutDocs } : {}) });
  await signIn(page);
  await canvasPainted(page);
  await settled(page);
}

/** The camera at rest, and the desk's box the same on two frames running. */
async function settled(page: Page): Promise<void> {
  let last = '';
  await expect.poll(async () => {
    const moving = await page.evaluate(() => __maDesk.camera.isMoving());
    const box = JSON.stringify(await deskBox(page, 'Personal'));
    const same = !moving && box === last;
    last = box;
    return same;
  }, { intervals: [250, 250, 250, 500, 500, 1000] }).toBe(true);
}

const deskButton = (page: Page, name: string): Locator => page.getByRole('button', { name: new RegExp(`^${name} desk, `) });
const deskBox = async (page: Page, name: string): Promise<Box> => (await deskButton(page, name).boundingBox())!;
/** A desk's place and size in the world, as the proxy layer has it from the layout store. */
const placed = (page: Page, name: string): Promise<{ x: number; y: number; w: number; h: number }> =>
  deskButton(page, name).evaluate((b: HTMLElement) => ({ x: parseFloat(b.style.left), y: parseFloat(b.style.top), w: parseFloat(b.style.width), h: parseFloat(b.style.height) }));
/** What filling the screen with a desk gives, as it always has: inside 48 units round it and the bars, up to 175 %. */
const fill = (w: number, h: number, vw: number, vh: number): number => Math.min(vw / (w + 96), (vh - 72 - 64) / (h + 96), 1.75);

interface SavedDesk { x: number; y: number; w: number; h: number; items: { id: string; app: string; x: number; y: number; w: number; h: number }[] }
/** The prod test account's saved first desk (Platform's read-only copy, Nov 12, Courier stored as `chat`): the default's five icons on a frame the member resized. */
const TEST_ACCOUNT_DESK: SavedDesk = {
  x: 0, y: 0, w: 781.96, h: 402.12,
  items: ['chat', 'notebook', 'browser', 'agent', 'files'].map((app, n) => ({ id: `${ID}:${app}`, app, x: 24 + 92 * n, y: 24, w: 76, h: 76 })),
};
const docOf = (desk: SavedDesk) => ({ [ME]: { version: 1, updatedAt: '2026-11-12T22:04:11Z', layout: { schemaVersion: 2, desks: { [ID]: desk }, z: [ID] } } });
const savedDesk = async (request: APIRequestContext): Promise<SavedDesk | undefined> =>
  ((await (await request.get('/__harness')).json()) as { layoutDocs: Record<string, { layout?: { desks: Record<string, SavedDesk> } } | undefined> }).layoutDocs[ME]?.layout?.desks[ID];
const zoom = (page: Page): Promise<number> => page.evaluate(() => __maDesk.camera.cam.s);

/** The desk's app tiles on screen: its four apps and Files. */
async function tiles(page: Page): Promise<Box[]> {
  const buttons = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^(Courier|Notebook|Browser|Agent|Files)\b/ });
  await expect(buttons).toHaveCount(5);
  return Promise.all((await buttons.all()).map(async (b) => (await b.boundingBox())!));
}

/** What the rule asks of a desk this wide on this screen: its width on screen, (2/3)·√(W·H). */
const ruleWidth = (s: Screen): number => (2 / 3) * Math.sqrt(s.w * s.h);

for (const screen of SCREENS) {
  test.describe(`a first office at ${screen.name}`, () => {
    const handheld = !!(screen.phone || screen.short);
    test.use({ viewport: { width: screen.w, height: screen.h }, deviceScaleFactor: screen.dpr, isMobile: handheld, hasTouch: handheld });

    test('opens on a naturally proportioned desk, framed as the owner asked', async ({ page, request }) => {
      const errors = watchConsole(page);
      await firstVisit(page, request);
      const desk = await deskBox(page, 'Personal');
      const s = await zoom(page);
      // Whole on screen, inside the bars.
      expect(desk.x).toBeGreaterThanOrEqual(0);
      expect(desk.x + desk.width).toBeLessThanOrEqual(screen.w);
      expect(desk.y).toBeGreaterThanOrEqual(screen.phone ? 0 : screen.short ? SHORT_BARS.top : 56);
      expect(desk.y + desk.height).toBeLessThanOrEqual(screen.h - (screen.phone ? 0 : screen.short ? SHORT_BARS.bottom : 56));
      const sizes = (await tiles(page)).map((t) => Math.min(t.width, t.height));
      if (screen.short) {
        // A phone on its side takes the phone's own fit, by height (ADR 0057): the desk fills the room between the one-row
        // bars with the phone's 16-unit margin, not the rule's share, so its tiles stay a finger's size (41 px; 33 under the
        // rule; main's 584 x 236 desk had 58 at 2.47:1).
        expect(desk.width / desk.height).toBeGreaterThanOrEqual(1.6);
        expect(desk.width / desk.height).toBeLessThanOrEqual(2);
        expect(Math.abs(desk.x + desk.width / 2 - screen.w / 2)).toBeLessThanOrEqual(2);
        const room = screen.h - SHORT_BARS.top - SHORT_BARS.bottom;
        expect(Math.abs(desk.y + desk.height / 2 - (SHORT_BARS.top + room / 2))).toBeLessThanOrEqual(2);
        expect(desk.height / room).toBeGreaterThanOrEqual(0.9);
        expect(Math.min(...sizes)).toBeGreaterThanOrEqual(40);
      } else if (screen.phone) {
        // The phone's own fit: the cell grid across the width (16 px margins), tiles a thumb's size.
        expect(desk.width / screen.w).toBeGreaterThan(0.85);
        expect(Math.min(...sizes)).toBeGreaterThanOrEqual(56);
        expect(Math.max(...sizes)).toBeLessThanOrEqual(90);
      } else {
        // Natural proportions: 16:10 to 2:1.
        expect(desk.width / desk.height).toBeGreaterThanOrEqual(1.6);
        expect(desk.width / desk.height).toBeLessThanOrEqual(2);
        // Half the width at 16:9; elsewhere the same share of the area, 4 / (9a): (2/3)·√(W·H) wide, within 3 %.
        if (Math.abs(screen.w / screen.h - 16 / 9) < 0.01) expect(Math.abs(desk.width / screen.w - 0.5)).toBeLessThanOrEqual(0.015);
        expect(Math.abs(desk.width / ruleWidth(screen) - 1)).toBeLessThanOrEqual(0.03);
        const a = desk.width / desk.height;
        expect(Math.abs((desk.width * desk.height) / (screen.w * screen.h) / (4 / (9 * a)) - 1)).toBeLessThanOrEqual(0.06);
        // Centred between the bars (72 above, 64 below).
        expect(Math.abs(desk.x + desk.width / 2 - screen.w / 2)).toBeLessThanOrEqual(2);
        expect(Math.abs(desk.y + desk.height / 2 - (72 + (screen.h - 136) / 2))).toBeLessThanOrEqual(2);
        // Near 100 % on laptop and desktop screens, so apps sit at a normal scale: tiles 48 to 90 px there. A larger
        // screen keeps the same share of itself, so its tiles grow with it, to 140 px at most.
        if (screen.w <= 1920) {
          // 48 to 90 px: 1024 x 768's tiles are 52, 1920 x 1080's 85.
          expect(Math.min(...sizes)).toBeGreaterThanOrEqual(48);
          expect(Math.max(...sizes)).toBeLessThanOrEqual(90);
          if (screen.w >= 1440) {
            expect(s).toBeGreaterThanOrEqual(0.85);
            expect(s).toBeLessThanOrEqual(1.15);
          }
        } else {
          expect(Math.max(...sizes)).toBeLessThanOrEqual(140);
        }
      }
      expect(errors).toEqual([]);
    });

    if (SHOTS) {
      for (const [theme, themeName] of THEMES) {
        test(`shot, ${themeName}`, async ({ page, request }) => {
          await setTheme(page, theme);
          await firstVisit(page, request);
          await page.waitForTimeout(600); // a scene's fade
          mkdirSync(SHOTS, { recursive: true });
          await page.screenshot({ path: join(SHOTS, `${LABEL}-${themeName}-${screen.name}.png`) });
        });
      }
    }
  });
}

test.describe('the framing after the first', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  test('a reload and a click on the desk keep it; Fit and 0 give it again; the member\'s own zoom is kept over a reload', async ({ page, request }) => {
    await firstVisit(page, request);
    const first = await deskBox(page, 'Personal');
    const s = await zoom(page);
    await page.reload();
    await canvasPainted(page);
    await settled(page);
    expect(await zoom(page)).toBeCloseTo(s, 3);
    const own = await deskBox(page, 'Personal');
    await page.mouse.click(own.x + own.width - 80, own.y + own.height / 2); // the member focuses it
    await settled(page);
    expect(await zoom(page)).toBeCloseTo(s, 3);
    expect((await deskBox(page, 'Personal')).width).toBeCloseTo(first.width, 0);

    await page.locator('.canvas-wrap').focus();
    await page.keyboard.press('+');
    await settled(page);
    const mine = await zoom(page);
    expect(mine).toBeGreaterThan(s * 1.1);
    await page.reload();
    await canvasPainted(page);
    await settled(page);
    expect(await zoom(page)).toBeCloseTo(mine, 3);
    await page.locator('.canvas-wrap').focus();
    await page.keyboard.press('0');
    await settled(page);
    expect(await zoom(page)).toBeCloseTo(s, 3);
  });

  test('a desk added later is a new desk too, and framed by the same rule when focused', async ({ page, request }) => {
    await firstVisit(page, request);
    await harness(request, { fleet: fleet([[ID, 'Personal', 'personal'], [ADDED, 'Work', 'work']]) });
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))); // polls the list
    const work = page.getByRole('button', { name: /^Work desk, / });
    await expect(work).toHaveCount(1);
    await page.locator('.canvas-wrap').focus();
    await page.keyboard.press('2');
    await expect.poll(async () => {
      const box = await work.boundingBox();
      return box ? Math.abs(box.x + box.width / 2 - 960) < 3 && !(await page.evaluate(() => __maDesk.camera.isMoving())) : false;
    }).toBe(true);
    const box = (await work.boundingBox())!;
    expect(box.width / box.height).toBeGreaterThanOrEqual(1.6);
    expect(box.width / box.height).toBeLessThanOrEqual(2);
    expect(Math.abs(box.width / 1920 - 0.5)).toBeLessThanOrEqual(0.015);
  });
});

// "Saved layouts the member has already arranged must not move": a saved desk keeps its size and place, and is framed as
// it always was. The framing is for a desk as the office introduced it.
test.describe('a saved desk', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });

  for (const [name, desk] of [
    ['the prod test account\'s resized first desk, 781.96 x 402.12', TEST_ACCOUNT_DESK],
    ['a first desk from before ADR 0057, 584 x 236, as saved', { ...TEST_ACCOUNT_DESK, w: 584, h: 236 }],
  ] as const) {
    test(`${name}: doesn't move, isn't saved again, and fills the screen as before`, async ({ page, request }) => {
      const errors = watchConsole(page);
      await firstVisit(page, request, docOf(desk));
      expect(await placed(page, 'Personal')).toEqual({ x: desk.x, y: desk.y, w: desk.w, h: desk.h });
      expect(await zoom(page)).toBeCloseTo(fill(desk.w, desk.h, 1920, 1080), 3);
      await focusCanvas(page);
      await page.keyboard.press('0');
      await settled(page);
      expect(await zoom(page)).toBeCloseTo(fill(desk.w, desk.h, 1920, 1080), 3);
      await page.waitForTimeout(2500); // past a save's 2 s wait: nothing changed, so nothing goes
      expect(await savedDesk(request)).toEqual(desk);
      expect(errors).toEqual([]);
    });
  }

  test('a new desk the member resizes is theirs: Fit then fills the screen with it, as with any saved desk', async ({ page, request }) => {
    await firstVisit(page, request);
    const framed = await zoom(page);
    await deskButton(page, 'Personal').focus();
    await page.keyboard.press('r');
    const row = page.getByRole('group', { name: /^Resizing / });
    await row.getByRole('button', { name: 'Wider' }).click();
    await row.getByRole('button', { name: 'Keep' }).click();
    const now = await placed(page, 'Personal');
    expect(now).toMatchObject({ w: 860 + 92, h: 480 });
    expect(await zoom(page)).toBeCloseTo(framed, 3); // a resize leaves the camera alone
    await focusCanvas(page);
    await page.keyboard.press('0');
    await settled(page);
    expect(await zoom(page)).toBeCloseTo(fill(now.w, now.h, 1920, 1080), 3);
    await expect.poll(async () => (await savedDesk(request))?.w).toBe(860 + 92);
  });
});

// The next member in the same browser (ADR 0057): the camera and the view this browser keeps are the last member's, and
// they survive a sign-out (ISS-67), so each is stamped with its member while signed in, and left with no id at a sign-out
// (ISS-89); the next member's first office is framed as a first office is, never where the last member left their camera.
test.describe('the next member in this browser', () => {
  test.use({ viewport: { width: 1920, height: 1080 } });
  const BAKERY = 'd-bakery0000001';

  test('A zooms and pans away, signs out; B signs in, and B\'s new desk is framed by the owner\'s rule', async ({ page, request }) => {
    const errors = watchConsole(page);
    await firstVisit(page, request);
    const framed = await zoom(page);
    // A's own view: zoomed in twice and dragged aside, a free camera this browser keeps.
    await focusCanvas(page);
    await page.keyboard.press('+');
    await settled(page);
    await page.keyboard.press('+'); // each step from where the last one landed
    await settled(page);
    const zoomed = await deskBox(page, 'Personal');
    expect(zoomed.x).toBeGreaterThan(120); // room for a drag on the empty canvas left of it
    await page.mouse.move(60, 540);
    await page.mouse.down();
    await page.mouse.move(460, 300, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const kept = await page.evaluate(() => ({ cam: JSON.parse(localStorage.getItem('ma.camera.v1') ?? 'null'), view: JSON.parse(localStorage.getItem('ma.view.v1') ?? 'null') }));
    expect(kept.view).toMatchObject({ mode: 'free' });
    expect(kept.cam.s).toBeGreaterThan(framed * 1.4);

    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await expect(page.getByTestId('sign-in')).toContainText("You're signed out.");
    // What A left in this browser is still there, as the device's own (ISS-67), but with nothing of A's id in it (ISS-89):
    // stamped as left at a sign-out, nobody's to start on.
    const left = await page.evaluate(() => ({ cam: JSON.parse(localStorage.getItem('ma.camera.v1') ?? 'null') as { s: number; owner: unknown } | null, view: JSON.parse(localStorage.getItem('ma.view.v1') ?? 'null') as { owner: unknown } | null }));
    expect(left.cam?.s).toBeCloseTo(kept.cam.s, 3);
    expect([left.cam?.owner, left.view?.owner]).toEqual([false, false]);
    expect(await page.evaluate((me) => Object.keys(localStorage).filter((k) => (localStorage.getItem(k) ?? '').includes(me)), ME)).toEqual([]);

    await harness(request, { userId: 'u-other', fleet: fleet([[BAKERY, 'Bakery', 'personal']]) });
    await signIn(page);
    await canvasPainted(page);
    await expect(deskButton(page, 'Bakery')).toHaveCount(1);
    let last = '';
    await expect.poll(async () => {
      const now = JSON.stringify(await deskButton(page, 'Bakery').boundingBox());
      const still = !(await page.evaluate(() => __maDesk.camera.isMoving())) && now === last;
      last = now;
      return still;
    }, { intervals: [250, 250, 250, 500, 500, 1000] }).toBe(true);
    const desk = await deskBox(page, 'Bakery');
    expect(await zoom(page)).toBeCloseTo(framed, 3);
    expect(Math.abs(desk.width / 1920 - 0.5)).toBeLessThanOrEqual(0.015);
    expect(Math.abs(desk.x + desk.width / 2 - 960)).toBeLessThanOrEqual(2);
    // How: each was stamped with A while A was signed in (`state/deviceOwner.ts`), left with no id at the sign-out, and B's
    // arrival put the view back to a first visit's.
    expect([kept.view.owner, kept.cam.owner]).toEqual([ME, ME]);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ma.view.v1') ?? 'null'))).toMatchObject({ mode: 'desk', activeDesk: BAKERY, owner: 'u-other' });
    expect(errors).toEqual([]);
  });
});

// "The rule must not stop a placed tile working" (the review, Nov 12): a tile made open on a new desk goes live there.
// At 1440 x 900 the rule's 88 % makes a 536-wide tile 473 px, under the 480 x 320 an open tile needs (ADR 0053), so once
// the member lets go of it the office frames the grown desk as any arranged desk, and the tile goes live with no Fit.
test.describe('an open tile on a new desk', () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test('the desk grown a row and the Notebook made open from the keyboard: it goes live in its tile', async ({ page, request }) => {
    const errors = watchConsole(page);
    await firstVisit(page, request);
    expect(await zoom(page)).toBeCloseTo((2 / 3) * Math.sqrt(1440 * 900) / 860, 3);
    // The desk a row taller (480 to 572), so a 6 x 5 tile has room under the top.
    await deskButton(page, 'Personal').focus();
    await page.keyboard.press('r');
    const row = page.getByRole('group', { name: /^Resizing / });
    await row.getByRole('button', { name: 'Taller' }).click();
    await row.getByRole('button', { name: 'Keep' }).click();
    expect(await placed(page, 'Personal')).toMatchObject({ w: 860, h: 572 });
    // The Notebook from 1 x 1 to 6 x 5 cells (536 x 444), a cell a press.
    await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Notebook/ }).focus();
    await page.keyboard.press('r');
    for (let n = 0; n < 5; n += 1) await row.getByRole('button', { name: 'Wider' }).click();
    for (let n = 0; n < 4; n += 1) await row.getByRole('button', { name: 'Taller' }).click();
    await row.getByRole('button', { name: 'Keep' }).click();
    const live = page.getByTestId('open-tile-notebook').locator('.open-tile-app');
    await expect(live).toBeVisible({ timeout: 10_000 });
    await settled(page);
    const box = (await page.getByTestId('open-tile-notebook').boundingBox())!;
    expect(box.width).toBeGreaterThanOrEqual(480);
    expect(box.height).toBeGreaterThanOrEqual(320);
    // Framed as any arranged desk now: filling the screen inside the margins and the bars.
    expect(await zoom(page)).toBeCloseTo(fill(860, 572, 1440, 900), 3);
    expect(errors).toEqual([]);
  });
});
