// The office tour (ADR 0056; the Product Designer's spec, `~/ma-coord/design-drafts/walkthrough/README.md` section 10).
// A new member's first visit shows it once, when the office is quiet; Next, Back, Skip, the close button, Esc and "Don't
// show this again", and what each keeps; focus in, kept in, and back; "Take the tour" from the logo's menu, its only way in
// (the owner, Nov 13: no switch and no "Take the tour" in the account menu); never a second time by itself, here or on
// another device; never over a menu, a notice or a sheet; Platform's `preferences.officeTour` once it's sent; which steps
// each member gets; the hole's corners running parallel to its target's; a phone; reduced motion; tiers and bands; the kill
// switches; axe on every step in Light, Zen and Dark. The harness has the tour off (`walkthrough: {enabled: false}`), so every other spec's fresh member
// never meets it; these turn it on. `TOUR_SHOTS=<dir>` also writes every step in three themes and the phone for review.
import { mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, type ThemeId, openMenuSection } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const ONE = [{ deskId: 'd-personal00001', name: 'Personal', kind: 'personal', state: 'running' }];
const TWO = [...ONE, { deskId: 'd-work000000001', name: 'Work', kind: 'work', state: 'running' }];
const CHUNK = /\/TourLayer-[^/]*\.js|\/tour-[^/]*\.css/;

const card = (page: Page) => page.getByTestId('tour');
const step = (page: Page, title: string) => page.getByRole('dialog', { name: title });
const nextBtn = (page: Page) => page.getByTestId('tour-next');
const count = (page: Page) => card(page).locator('.tour-count');
const accountButton = (page: Page) => page.getByRole('button', { name: 'Account', exact: true });
const tourSwitch = (page: Page) => page.getByRole('switch', { name: /office tour/ });
const INTRO = 'Welcome to your office';
const OFF_NOTE = "Turned off. You can take the tour again from the logo's menu, top left.";
/** One own desk, the harness's defaults (no Maia, no setup circle, the mark's menu on). */
const ONE_STEPS = [INTRO, 'Your desk', 'Apps', 'Move around', 'Privacy shield', 'Notifications', 'Your account', 'The rest of the Alliance'];
/** Personal and Work with Maia. */
const TWO_MAIA_STEPS = [INTRO, 'Your desks', 'Switch desks', 'Apps', 'Move around', 'Ask Maia', 'Privacy shield', 'Notifications', 'Your account', 'The rest of the Alliance'];

/** The account menu open: nothing of the tour in it (the owner, Nov 13), and no "Plain background". */
async function accountMenuHasNoTour(page: Page): Promise<void> {
  await expect(page.locator('.tour')).toHaveCount(0);
  await accountButton(page).click();
  const panel = page.getByRole('dialog', { name: 'Account', exact: true });
  await expect(panel).toBeVisible();
  await expect(tourSwitch(page)).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Take the tour' })).toHaveCount(0);
  await expect(panel.getByTestId('menu-take-tour')).toHaveCount(0);
  await expect(panel.getByRole('switch', { name: 'Plain background' })).toHaveCount(0);
  await expect(panel).not.toContainText(/tour|Plain background/i);
  await accountButton(page).click();
  await expect(panel).toHaveCount(0);
}

/** The logo's menu, by keyboard, then its "Take the tour". */
async function takeTheTour(page: Page): Promise<void> {
  await page.locator('.home-mark-btn').focus();
  await page.keyboard.press('Enter');
  await page.locator('#mark-menu').getByRole('button', { name: 'Take the tour' }).click();
  await expect(step(page, INTRO)).toBeVisible();
}

/**
 * The hole's corner on screen against the target's own corner grown by the step's pad (never more than half the hole's
 * short side), once the hole has settled. `world`: a canvas radius (`canvas/layout.ts`) for a desk's or a tile's proxy, under
 * the camera's scale; else the element's own CSS corner.
 */
async function corners(page: Page, selector: string, pad: number, world?: number): Promise<{ hole: number; want: number }> {
  await page.waitForTimeout(450); // the hole's 300 ms glide
  return page.evaluate(([sel, pad, world]) => {
    const el = document.querySelector(sel as string) as HTMLElement;
    const box = el.getBoundingClientRect();
    const own = world === null ? parseFloat(getComputedStyle(el).borderTopLeftRadius) : (world as number) * (box.width / parseFloat(el.style.width));
    const hole = document.querySelector('.tour-hole') as HTMLElement;
    const h = hole.getBoundingClientRect();
    return { hole: parseFloat(getComputedStyle(hole).borderTopLeftRadius), want: Math.min(Math.min(own, box.width / 2, box.height / 2) + (pad as number), Math.min(h.width, h.height) / 2) };
  }, [selector, pad, world ?? null] as const);
}

async function office(page: Page, request: APIRequestContext, extra: Record<string, unknown> = {}): Promise<void> {
  await harness(request, { walkthrough: null, fleet: ONE, ...extra });
  await signIn(page);
  await canvasPainted(page);
}

/** The layout document's `prefs.tourOff` on "Platform", for whichever member saved one; undefined when none did. */
async function docTourOff(request: APIRequestContext): Promise<unknown> {
  const s = (await (await request.get('/__harness')).json()) as { layoutDocs: Record<string, { layout?: { prefs?: Record<string, unknown> } | null } | undefined> };
  for (const doc of Object.values(s.layoutDocs ?? {})) if (doc?.layout?.prefs?.['tourOff'] !== undefined) return doc.layout.prefs['tourOff'];
  return undefined;
}

async function harnessState<T>(request: APIRequestContext, key: string): Promise<T> {
  return ((await (await request.get('/__harness')).json()) as Record<string, T>)[key]!;
}

/** The office after a load, given time for the tour to have started if it were going to (800 ms of quiet and more). */
async function settledWithoutTour(page: Page): Promise<void> {
  await canvasPainted(page);
  await page.waitForTimeout(2500);
  await expect(card(page)).toHaveCount(0);
}

/** Serious and critical axe violations inside the tour. */
async function axeTour(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    interface Rule { id: string; impact: string | null; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run({ include: [['.tour']] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] }, resultTypes: ['violations'] });
    return r.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

/** Next until Done, then Done; the titles seen on the way. */
async function throughToDone(page: Page, press: 'click' | 'tap' = 'click'): Promise<string[]> {
  const seen: string[] = [];
  for (let k = 0; k < 16; k++) {
    await expect(card(page)).toBeVisible();
    seen.push(await card(page).locator('.tour-title').innerText());
    const done = (await nextBtn(page).textContent()) === 'Done';
    await nextBtn(page)[press]();
    if (done) break;
    await page.waitForTimeout(400); // the card's 340 ms
  }
  return seen;
}

/** Where the hole is, and whether it holds an element's middle. */
async function holeHolds(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const hole = document.querySelector('.tour-hole')!.getBoundingClientRect();
    const el = document.querySelector(sel)!.getBoundingClientRect();
    const cx = el.left + el.width / 2;
    const cy = el.top + el.height / 2;
    return hole.width > 0 && cx > hole.left && cx < hole.right && cy > hole.top && cy < hole.bottom;
  }, selector);
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('a first visit: it starts by itself once the office is quiet; Next, Back and Done; then never by itself, here or on another device', async ({ page, request, browser }) => {
  await office(page, request);
  await expect(step(page, INTRO)).toBeVisible();
  // One desk, no Guild Desk, one scope, no Maia and no setup circle: their steps left out, not pointed at nothing.
  await expect(count(page)).toHaveText('1 of 8');
  await expect(nextBtn(page)).toBeFocused();
  // The intro wears the Alliance's mark, the theme's own.
  await expect(card(page).locator('.tour-mark img:visible')).toHaveCount(1);
  await expect(card(page)).toHaveAttribute('data-step', 'intro');
  await expect(page.getByTestId('tour-skip')).toHaveText('Skip');
  // The rest of the office is inert under it.
  expect(await page.locator('.desks-main').evaluate((el) => (el as HTMLElement).inert)).toBe(true);

  await nextBtn(page).click();
  await expect(step(page, 'Your desk')).toBeVisible();
  await expect(count(page)).toHaveText('2 of 8');
  await expect(nextBtn(page)).toBeFocused(); // the same button from step to step
  await expect.poll(() => holeHolds(page, '#proxy-d-personal00001')).toBe(true);
  await page.getByTestId('tour-back').click();
  await expect(step(page, INTRO)).toBeVisible();
  await expect(nextBtn(page)).toBeFocused(); // arriving at step 1, Back became Skip: focus is on Next
  await nextBtn(page).click();
  await nextBtn(page).click();
  await expect(step(page, 'Apps')).toBeVisible();
  await expect.poll(() => holeHolds(page, '[id="proxy-d-personal00001:browser"]')).toBe(true);
  for (const [title, target] of [
    ['Move around', '.bottombar .zoom-ctl'],
    ['Privacy shield', '.topbar button[aria-label="Privacy shield"]'],
    ['Notifications', '.topbar [data-testid="bell"]'],
    ['Your account', '.topbar .account-btn'],
  ] as const) {
    await nextBtn(page).click();
    await expect(step(page, title)).toBeVisible();
    await expect.poll(() => holeHolds(page, target)).toBe(true);
  }
  await nextBtn(page).click();
  await expect(step(page, 'The rest of the Alliance')).toBeVisible();
  await expect(count(page)).toHaveText('8 of 8');
  await expect.poll(() => holeHolds(page, '.home-mark-btn')).toBe(true);
  await expect(page.getByTestId('tour-off')).toHaveCount(0); // Done does the same on the last step
  await expect(nextBtn(page)).toHaveText('Done');
  await nextBtn(page).click();
  await expect(page.locator('.tour')).toHaveCount(0);
  expect(await page.locator('.desks-main').evaluate((el) => (el as HTMLElement).inert)).toBe(false);
  await expect(page.locator('.notices')).not.toContainText('Turned off'); // the note is the off link's alone
  await expect.poll(() => docTourOff(request), { timeout: 15_000 }).toBe(true);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ma.tour.v1') ?? 'null'))).toEqual({ who: 'u-test', off: true });
  // Platform doesn't send preferences.officeTour today, so nothing was asked of it.
  expect(await harnessState<unknown[]>(request, 'preferencePuts')).toEqual([]);

  await page.reload();
  await settledWithoutTour(page);

  // Another device: nothing in its storage, and the document says the tour is done.
  const other = await browser.newContext({ baseURL: test.info().project.use.baseURL });
  const there = await other.newPage();
  await signIn(there);
  await settledWithoutTour(there);
  await other.close();
});

test('Skip, the close button and Esc end it and keep nothing: it starts again the next time the office opens; the office never hears that Esc', async ({ page, request }) => {
  await office(page, request);
  await expect(step(page, INTRO)).toBeVisible();
  await page.getByTestId('tour-skip').click();
  await expect(page.locator('.tour')).toHaveCount(0);

  await page.reload();
  await canvasPainted(page);
  await expect(step(page, INTRO)).toBeVisible();
  await page.getByRole('button', { name: 'Close the tour' }).click(); // the intro's, in its corner
  await expect(page.locator('.tour')).toHaveCount(0);

  await page.reload();
  await canvasPainted(page);
  await expect(step(page, INTRO)).toBeVisible();
  await nextBtn(page).click();
  await expect(step(page, 'Your desk')).toBeVisible();
  await page.getByRole('button', { name: 'Close the tour' }).click();
  await expect(page.locator('.tour')).toHaveCount(0);

  await page.reload();
  await canvasPainted(page);
  await expect(step(page, INTRO)).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as { escapes: number };
    w.escapes = 0;
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' || e.key === 'ArrowRight') w.escapes += 1;
    });
  });
  await page.keyboard.press('ArrowRight'); // no key reaches the office while it's open
  await page.keyboard.press('Escape');
  await expect(page.locator('.tour')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { escapes: number }).escapes)).toBe(0);
  await page.waitForTimeout(3000);
  expect(await docTourOff(request)).toBeUndefined();
  expect(await page.evaluate(() => localStorage.getItem('ma.tour.v1'))).toBeNull();

  await page.reload();
  await canvasPainted(page);
  await expect(step(page, INTRO)).toBeVisible();
});

test("Don't show this again: its note once, naming the logo's menu; never by itself again; the logo's menu still starts it, and writes nothing", async ({ page, request }) => {
  await office(page, request);
  await expect(step(page, INTRO)).toBeVisible();
  await page.getByTestId('tour-off').click();
  await expect(page.locator('.tour')).toHaveCount(0);
  const note = page.locator('.notices [role="status"]', { hasText: OFF_NOTE });
  await expect(note).toHaveCount(1);
  await expect(note).toHaveCount(0, { timeout: 8000 });
  await expect.poll(() => docTourOff(request), { timeout: 15_000 }).toBe(true);

  // No switch to turn it back on, and no other way in, in the account menu.
  await accountMenuHasNoTour(page);
  await page.reload();
  await settledWithoutTour(page);

  // The logo's menu starts it whatever the setting, and the setting stays as it was.
  await takeTheTour(page);
  await page.getByTestId('tour-skip').click();
  await expect(page.locator('.tour')).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(await docTourOff(request)).toBe(true);
  await page.reload();
  await settledWithoutTour(page);
});

test('the account menu has nothing of the tour and no "Plain background", on a first visit too', async ({ page, request }) => {
  await office(page, request);
  await expect(step(page, INTRO)).toBeVisible();
  await page.getByTestId('tour-skip').click();
  await expect(page.locator('.tour')).toHaveCount(0);
  await accountMenuHasNoTour(page);
});

test('Take the tour, from the mark menu by keyboard, whatever the setting: focus in, Tab kept to its four controls, and back to the mark', async ({ page, request }) => {
  await office(page, request);
  await page.getByTestId('tour-off').click();
  await expect(page.locator('.tour')).toHaveCount(0);
  const mark = page.locator('.home-mark-btn');
  await mark.focus();
  await page.keyboard.press('Enter');
  const rows = page.locator('#mark-menu').locator('button, a');
  // Its place: the first group, after All desks where there's one (one desk: none), before Forums and Help.
  await expect(rows.first()).toHaveText('Take the tour');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#mark-menu').getByRole('button', { name: 'Take the tour' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#mark-menu')).toHaveCount(0);
  await expect(step(page, INTRO)).toBeVisible();
  await expect(nextBtn(page)).toBeFocused();
  const order: string[] = [];
  for (let k = 0; k < 5; k++) {
    await page.keyboard.press('Tab');
    order.push(await page.evaluate(() => document.activeElement?.closest('[data-testid="tour"]') ? (document.activeElement as HTMLElement).dataset['testid'] ?? '' : 'outside'));
  }
  expect(order).toEqual(['tour-off', 'tour-close', 'tour-skip', 'tour-next', 'tour-off']);
  await page.keyboard.press('Shift+Tab');
  await expect(nextBtn(page)).toBeFocused();
  // Enter on the card itself is Next.
  await card(page).focus();
  await page.keyboard.press('Enter');
  await expect(step(page, 'Your desk')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.tour')).toHaveCount(0);
  await expect(mark).toBeFocused();
  await expect.poll(() => docTourOff(request), { timeout: 15_000 }).toBe(true); // the off link's; Take the tour wrote nothing
  await page.reload();
  await settledWithoutTour(page);
});

test('on a desk, with two: Take the tour sits after All desks, and "Your desks" lights the desk on screen', async ({ page, request }) => {
  await office(page, request, { fleet: TWO });
  await expect(step(page, INTRO)).toBeVisible();
  await page.getByTestId('tour-skip').click();
  await page.locator('#proxy-d-personal00001').evaluate((el) => (el as HTMLElement).click()); // to the Personal desk
  await page.waitForTimeout(800);
  await page.locator('.home-mark-btn').focus();
  await page.keyboard.press('Enter');
  const rows = page.locator('#mark-menu').locator('button, a');
  await expect(rows.nth(0)).toHaveText('All desks');
  await expect(rows.nth(1)).toHaveText('Take the tour');
  await rows.nth(1).click();
  await expect(step(page, INTRO)).toBeVisible();
  await nextBtn(page).click();
  await expect(step(page, 'Your desks')).toBeVisible();
  await expect.poll(() => holeHolds(page, '#proxy-d-personal00001')).toBe(true);
  // Switch desks: the top bar's Personal, Work and All.
  await nextBtn(page).click();
  await expect(step(page, 'Switch desks')).toBeVisible();
  await expect.poll(() => holeHolds(page, '.topbar .segmented.scope:not(.scope-ghost)')).toBe(true);
});

test("the hole's corners run parallel to the target's: a desk's, a tile's and a pill control's own corner, grown by the pad", async ({ page, request }) => {
  await office(page, request, { fleet: TWO, maia: { enabled: true } });
  await expect(step(page, INTRO)).toBeVisible();
  await nextBtn(page).click();
  await expect(step(page, 'Your desks')).toBeVisible();
  // Every own desk in one hole, with a desk's corner (22 in the canvas's units) under the camera's scale, plus 10.
  let c = await corners(page, '#proxy-d-personal00001', 10, 22);
  expect(Math.abs(c.hole - c.want), JSON.stringify(c)).toBeLessThan(0.75);
  await nextBtn(page).click();
  await expect(step(page, 'Switch desks')).toBeVisible();
  c = await corners(page, '.topbar .segmented.scope:not(.scope-ghost)', 4);
  expect(Math.abs(c.hole - c.want), JSON.stringify(c)).toBeLessThan(0.75);
  await nextBtn(page).click();
  await expect(step(page, 'Apps')).toBeVisible();
  // The Browser's tile: a tile's 18 (an icon) or 20 (a widget) under the camera's scale, plus 8.
  const tile = page.locator('[id="proxy-d-personal00001:browser"]');
  const level = await tile.getAttribute('data-level');
  expect(level).toBeTruthy();
  c = await corners(page, '[id="proxy-d-personal00001:browser"]', 8, level === 'icon' ? 18 : 20);
  expect(Math.abs(c.hole - c.want), JSON.stringify(c)).toBeLessThan(0.75);
  expect(c.hole).toBeLessThan(40); // not a pill: a tile's corner
  await nextBtn(page).click();
  await expect(step(page, 'Move around')).toBeVisible();
  c = await corners(page, '.bottombar .zoom-ctl', 4);
  expect(Math.abs(c.hole - c.want), JSON.stringify(c)).toBeLessThan(0.75);
  await nextBtn(page).click();
  await expect(step(page, 'Ask Maia')).toBeVisible();
  // Maia's round button: a circle.
  const maia = await page.locator('.tour-hole').evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { r: parseFloat(getComputedStyle(el).borderTopLeftRadius), half: Math.min(r.width, r.height) / 2 };
  });
  expect(Math.abs(maia.r - maia.half)).toBeLessThan(0.75);
  await nextBtn(page).click();
  await expect(step(page, 'Privacy shield')).toBeVisible();
  c = await corners(page, '.topbar button[aria-label="Privacy shield"]', 4);
  expect(Math.abs(c.hole - c.want), JSON.stringify(c)).toBeLessThan(0.75);
  await nextBtn(page).click();
  await nextBtn(page).click();
  await expect(step(page, 'Your account')).toBeVisible();
  c = await corners(page, '.topbar .account-btn', 4);
  expect(Math.abs(c.hole - c.want), JSON.stringify(c)).toBeLessThan(0.75);
});

test('each step is said once from inside the dialog (VoiceOver hears nothing outside an open modal); leaving, it is no longer modal, so the note is heard', async ({ page, request }) => {
  await office(page, request);
  await expect(step(page, INTRO)).toBeVisible();
  const said = card(page).getByTestId('tour-said');
  await expect(said).toHaveCount(1);
  expect(await said.evaluate((el) => [el.getAttribute('role'), el.getAttribute('aria-live'), el.closest('[role="dialog"]')?.getAttribute('aria-modal')])).toEqual(['status', 'polite', 'true']);
  await expect(page.locator('.tour [role="status"]')).toHaveCount(1); // nothing live in the layer outside the card
  await expect(said).toHaveText(''); // the first step needs none: focus entering the dialog reads it
  await nextBtn(page).click();
  await expect(said).toHaveText(
    '2 of 8. Your desk. A desk is a desktop in the cloud, with a real browser, your files and the apps you choose. It keeps your tabs and sign-ins between visits, so you pick up where you left off on any device.',
  );
  const leaving = await page.evaluate(async () => {
    (document.querySelector('[data-testid="tour-off"]') as HTMLElement).click();
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const c = document.querySelector('[data-testid="tour"]');
    return { present: !!c, role: c?.getAttribute('role') ?? null, modal: c?.getAttribute('aria-modal') ?? null };
  });
  expect(leaving).toEqual({ present: true, role: 'dialog', modal: null }); // fading out, and not modal
  await expect(page.locator('.notices [role="status"]', { hasText: OFF_NOTE })).toHaveCount(1);
  await expect(page.locator('.tour')).toHaveCount(0);
});

test('the loading overlay (#ma-ld): it never starts under it, and starts once the overlay goes', async ({ page, request }) => {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    document.addEventListener('DOMContentLoaded', () => {
      const d = document.createElement('div');
      d.id = 'ma-ld';
      d.setAttribute('role', 'status');
      d.style.cssText = 'position:fixed;inset:0;z-index:100;background:Canvas';
      document.body.append(d);
    });
  });
  await office(page, request);
  await page.waitForTimeout(3000);
  await expect(page.locator('.tour')).toHaveCount(0);
  await page.evaluate(() => document.getElementById('ma-ld')?.remove());
  await expect(step(page, INTRO)).toBeVisible();
});

test("the loader's own overlay (ADR 0058): the tour starts only after the office has taken it away", async ({ page, request }) => {
  await page.addInitScript(() => {
    if (window !== window.top) return;
    const seen: { up?: number; going?: number; tour?: number } = {};
    (window as unknown as { __ld: typeof seen }).__ld = seen;
    const look = (): void => {
      const ld = document.getElementById('ma-ld');
      if (ld && seen.up === undefined) seen.up = performance.now();
      if (seen.up !== undefined && seen.going === undefined && (!ld || ld.getAttribute('aria-hidden') === 'true')) seen.going = performance.now();
      if (seen.tour === undefined && document.querySelector('.tour')) seen.tour = performance.now();
    };
    new MutationObserver(look).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-hidden'] });
  });
  // The desk list a second late, so the overlay stands over the office for a while.
  await office(page, request, { desksDelayMs: 1000 });
  await expect(step(page, INTRO)).toBeVisible();
  const seen = await page.evaluate(() => (window as unknown as { __ld: { up?: number; going?: number; tour?: number } }).__ld);
  expect(seen.up).toBeDefined();
  expect(seen.going).toBeDefined();
  expect(seen.tour).toBeGreaterThanOrEqual(seen.going!);
  await expect(page.locator('#ma-ld')).toHaveCount(0);
});

test("A has the tour open, signs out in another tab, and B signs in there: A's tour goes from this tab at once, and B's own first visit starts it for B", async ({ page, context, request }) => {
  test.setTimeout(60_000);
  // Short access tokens, so this tab's next call refreshes and gets whoever's token the browser keeps by then.
  await office(page, request, { expiresIn: 60 });
  await expect(step(page, INTRO)).toBeVisible();
  await nextBtn(page).click();
  await expect(step(page, 'Your desk')).toBeVisible(); // A's, on its second step

  const two = await context.newPage();
  await two.goto('/');
  await expect(two.getByRole('dialog', { name: INTRO })).toBeVisible(); // A's first visit there too
  await two.keyboard.press('Escape');
  await two.getByRole('button', { name: 'Account', exact: true }).click();
  await two.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(two.getByTestId('sign-in')).toContainText("You're signed out.");
  await harness(request, { userId: 'u-other', fleet: TWO });
  await two.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(two.locator('.ma-shell')).toBeVisible();

  // This tab is looked at again: its refresh finds B's token.
  await page.bringToFront();
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => page.evaluate(() => localStorage.getItem('ma.layout.owner.v1')), { timeout: 15_000 }).toBe('u-other');
  await expect(step(page, 'Your desk')).toHaveCount(0); // A's tour went with A, with nothing written
  // B's own first visit, decided afresh in this tab with no reload: B has Personal and Work.
  await expect(step(page, INTRO)).toBeVisible({ timeout: 15_000 });
  await nextBtn(page).click();
  await expect(step(page, 'Your desks')).toBeVisible();
  expect(await docTourOff(request)).toBeUndefined();
  await two.close();
});

test('never starts over a menu in use, and starts once it closes; a sheet arriving ends it with nothing kept', async ({ page, request }) => {
  await harness(request, { walkthrough: null, fleet: ONE, layoutDelayMs: 2500 });
  await signIn(page);
  await canvasPainted(page);
  await accountButton(page).click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
  await page.waitForTimeout(4000);
  await expect(page.locator('.tour')).toHaveCount(0);
  await accountButton(page).click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toHaveCount(0);
  await expect(step(page, INTRO)).toBeVisible();
  await page.evaluate(() => {
    const d = document.createElement('div');
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-modal', 'true');
    d.style.cssText = 'position:fixed;inset:40px;z-index:70';
    d.textContent = 'A sheet';
    document.body.append(d);
  });
  await expect(page.locator('.tour')).toHaveCount(0);
  await page.waitForTimeout(3000);
  expect(await docTourOff(request)).toBeUndefined();
});

test('a menu open anyway (one that opened as the tour began) comes first: the tour steps back, keys and presses are the menu\'s, and it comes back on the same step as the menu shuts', async ({ page, request }) => {
  await office(page, request);
  await expect(step(page, INTRO)).toBeVisible();
  await expect(count(page)).toHaveText('1 of 8');
  // The office is held under the tour, so no press reaches the bar: the account menu opens the way a race would leave it.
  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>('[inert]')) el.inert = false;
    document.querySelector<HTMLButtonElement>('.topbar .account-btn')!.click();
  });
  const panel = page.getByRole('dialog', { name: 'Account', exact: true });
  await expect(panel).toBeVisible();
  // Stepped back: no card, no scrim, nothing of it takes a press, and the office isn't held.
  await expect(page.locator('.tour')).toHaveClass(/\byield\b/);
  await expect(card(page)).toBeHidden();
  expect(await page.locator('.tour').evaluate((el) => getComputedStyle(el).pointerEvents)).toBe('none');
  expect(await page.evaluate(() => document.querySelectorAll('[inert]').length)).toBe(0);
  // The menu is the member's: its own Esc shuts it, and the tour hears none of it (its Esc would have ended it).
  await accountButton(page).focus();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  // Back on the same step, the office held again, the keyboard on Next.
  await expect(step(page, INTRO)).toBeVisible();
  await expect(count(page)).toHaveText('1 of 8');
  await expect(page.locator('.tour')).not.toHaveClass(/\byield\b/);
  await expect(nextBtn(page)).toBeFocused();
  expect(await page.evaluate(() => document.querySelectorAll('[inert]').length)).toBeGreaterThan(0);
  await nextBtn(page).click();
  await expect(step(page, 'Your desk')).toBeVisible();
  expect(await docTourOff(request)).toBeUndefined();
});

test('never over a notice: the close hold\'s card holds it back for as long as it shows', async ({ page, request }) => {
  await office(page, request, { notices: [{ kind: 'close_hold_cancelled', at: new Date().toISOString(), requestedAt: new Date(Date.now() - 86_400_000).toISOString() }] });
  await expect(page.getByText('Got it')).toBeVisible();
  await page.waitForTimeout(2500);
  await expect(page.locator('.tour')).toHaveCount(0);
  await page.getByText('Got it').click();
  await expect(step(page, INTRO)).toBeVisible();
});

test('nothing behind it scrolls or zooms: a wheel and a pinch on the scrim move nothing', async ({ page, request }) => {
  await office(page, request);
  await expect(step(page, INTRO)).toBeVisible();
  const scale = () => page.evaluate(() => (window as unknown as { __maDesk: { camera: { cam: { s: number; x: number } } } }).__maDesk.camera.cam);
  const before = await scale();
  await page.mouse.move(200, 600);
  await page.mouse.wheel(0, 400);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -300);
  await page.keyboard.up('Control');
  await page.mouse.click(200, 600); // a press on the scrim does nothing
  await page.waitForTimeout(500);
  expect(await scale()).toEqual(before);
  await expect(step(page, INTRO)).toBeVisible();
  expect(await page.evaluate(() => window.visualViewport?.scale)).toBe(1);
  await expect(nextBtn(page)).toBeFocused();
});

test.describe('who gets which steps', () => {
  test('Personal and Work, Maia on, a teen: "Your desks", switching desks, her step, ten in all, the same words', async ({ page, request }) => {
    await office(page, request, { fleet: TWO, maia: { enabled: true }, age: 'teen' });
    await expect(step(page, INTRO)).toBeVisible();
    await expect(count(page)).toHaveText(`1 of ${TWO_MAIA_STEPS.length}`);
    await nextBtn(page).click();
    await expect(step(page, 'Your desks')).toBeVisible();
    // The overview: both desks in one hole.
    await expect.poll(() => holeHolds(page, '#proxy-d-personal00001')).toBe(true);
    expect(await holeHolds(page, '#proxy-d-work000000001')).toBe(true);
    await page.getByTestId('tour-back').click();
    await expect(step(page, INTRO)).toBeVisible();
    expect(await throughToDone(page)).toEqual(TWO_MAIA_STEPS);
  });

  test('setup still to finish: its step, on the setup circle', async ({ page, request }) => {
    await office(page, request, { setupCircle: null });
    await expect(step(page, INTRO)).toBeVisible();
    const seen = await throughToDone(page);
    expect(seen).toEqual([INTRO, 'Your desk', 'Apps', 'Move around', 'Finish setting up', 'Privacy shield', 'Notifications', 'Your account', 'The rest of the Alliance']);
  });

  test('a free member with Maia\'s trial: the same tour, her step included', async ({ page, request }) => {
    await office(page, request, { membership: { status: 'active', tier: 'free' }, maia: { enabled: true, trial: 'unused' } });
    await expect(step(page, INTRO)).toBeVisible();
    expect(await throughToDone(page)).toEqual([INTRO, 'Your desk', 'Apps', 'Move around', 'Ask Maia', 'Privacy shield', 'Notifications', 'Your account', 'The rest of the Alliance']);
  });

  test('the logo\'s menu switched off: no logo step, and still no way in from the account menu', async ({ page, request }) => {
    await office(page, request, { configExtra: { markMenu: { enabled: false } } });
    await expect(step(page, INTRO)).toBeVisible();
    expect(await throughToDone(page)).toEqual(ONE_STEPS.slice(0, -1));
    await accountMenuHasNoTour(page);
  });

  test('a Browser window open on the desk: Take the tour leaves out the tile it covers', async ({ page, request }) => {
    await office(page, request);
    await page.getByTestId('tour-skip').click();
    await page.locator('[id="proxy-d-personal00001:browser"]').evaluate((el) => (el as HTMLElement).click());
    await expect(page.locator('.ma-window')).toBeVisible();
    await page.locator('.home-mark-btn').focus();
    await page.keyboard.press('Enter');
    await page.locator('#mark-menu').getByRole('button', { name: 'Take the tour' }).click();
    await expect(step(page, INTRO)).toBeVisible();
    const seen = await throughToDone(page);
    expect(seen[0]).toBe(INTRO);
    expect(seen).not.toContain('Apps');
  });

  test('no own desk: no tour, no row', async ({ page, request }) => {
    await harness(request, { walkthrough: null, fleet: [{ deskId: 'd-guild0000001', name: 'Guild', kind: 'guild', state: 'running' }] });
    await signIn(page);
    await settledWithoutTour(page);
    await page.locator('.home-mark-btn').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#mark-menu')).toBeVisible();
    await expect(page.locator('#mark-menu').getByRole('button', { name: 'Take the tour' })).toHaveCount(0);
  });
});

test.describe("Platform's preferences.officeTour, once it's sent", () => {
  test('sent and never set: the tour starts, and Done goes to PUT /v1/me/preferences as well as the document', async ({ page, request }) => {
    await office(page, request, { officeTour: null });
    await expect(step(page, INTRO)).toBeVisible();
    await throughToDone(page);
    await expect.poll(() => harnessState<{ body: unknown; status: number }[]>(request, 'preferencePuts')).toEqual([{ body: { officeTour: { off: true } }, status: 200 }]);
    await expect.poll(() => docTourOff(request), { timeout: 15_000 }).toBe(true);
  });

  test("Platform says off on a new device: it doesn't start, and the logo's menu still starts it, asking nothing of Platform", async ({ page, request }) => {
    await office(page, request, { officeTour: { off: true, at: '2026-11-12T20:00:00Z' } });
    await page.waitForTimeout(2500);
    await expect(page.locator('.tour')).toHaveCount(0);
    await accountMenuHasNoTour(page);
    await takeTheTour(page);
    await page.keyboard.press('Escape');
    await expect(page.locator('.tour')).toHaveCount(0);
    await page.waitForTimeout(1500);
    expect(await harnessState<unknown[]>(request, 'preferencePuts')).toEqual([]);
  });
});

test('reduced motion: no animation or transition runs on the tour', async ({ page, request }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await office(page, request, { fleet: TWO });
  await expect(step(page, INTRO)).toBeVisible();
  const running = () => page.evaluate(() => document.getAnimations().filter((a) => (a.effect as KeyframeEffect | null)?.target?.closest('.tour')).length);
  expect(await running()).toBe(0);
  await nextBtn(page).click();
  await expect(step(page, 'Your desks')).toBeVisible(); // at once: no 100 ms wait for the words
  expect(await running()).toBe(0);
  expect(await page.locator('.tour-hole').evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0s');
  await nextBtn(page).click();
  expect(await running()).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.tour')).toHaveCount(0); // gone at once
});

test('the kill switch: no tour, no Take the tour, and none of its code or styles fetched', async ({ page, request }) => {
  const fetched: string[] = [];
  page.on('request', (r) => fetched.push(r.url()));
  await harness(request, { walkthrough: { enabled: false }, fleet: ONE });
  await signIn(page);
  await settledWithoutTour(page);
  await page.locator('.home-mark-btn').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#mark-menu')).toBeVisible();
  await expect(page.locator('#mark-menu').getByRole('button', { name: 'Take the tour' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await accountButton(page).click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
  await expect(tourSwitch(page)).toHaveCount(0);
  expect(fetched.filter((u) => CHUNK.test(u))).toEqual([]);
});

test("a second visit fetches none of it: only the first load's check runs", async ({ page, request }) => {
  await office(page, request);
  await page.getByTestId('tour-off').click();
  await expect.poll(() => docTourOff(request), { timeout: 15_000 }).toBe(true);
  const fetched: string[] = [];
  page.on('request', (r) => fetched.push(r.url()));
  await page.reload();
  await settledWithoutTour(page);
  expect(fetched.filter((u) => CHUNK.test(u))).toEqual([]);
});

test.describe('a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('docked to the bottom, 12 px from each side, 44 px targets; Maia\'s step on top; every step to Done', async ({ page, request }) => {
    await office(page, request, { maia: { enabled: true } });
    await expect(step(page, INTRO)).toBeVisible();
    const box = (await card(page).boundingBox())!;
    expect(box.x).toBe(12);
    expect(box.width).toBe(390 - 24);
    expect(box.y + box.height).toBeGreaterThan(844 - 12 - 2);
    for (const id of ['tour-skip', 'tour-next', 'tour-close']) expect((await page.getByTestId(id).boundingBox())!.height).toBe(44);
    expect((await page.getByTestId('tour-off').boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await card(page).locator('.tour-caret').count()).toBe(0);
    const seen: string[] = [];
    for (let k = 0; k < 16; k++) {
      const title = await card(page).locator('.tour-title').innerText();
      seen.push(title);
      if (title === 'Ask Maia') expect((await card(page).boundingBox())!.y).toBeLessThan(100);
      const done = (await nextBtn(page).textContent()) === 'Done';
      await nextBtn(page).tap();
      if (done) break;
      await page.waitForTimeout(400);
    }
    expect(seen).toEqual([INTRO, 'Your desk', 'Apps', 'Move around', 'Ask Maia', 'Privacy shield', 'Notifications', 'Your account', 'The rest of the Alliance']);
    await expect(page.locator('.tour')).toHaveCount(0);
    await expect.poll(() => docTourOff(request), { timeout: 15_000 }).toBe(true);
  });
});

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  for (const phone of [false, true]) {
    test(`axe on every step, ${theme}${phone ? ', phone' : ''}`, async ({ browser, request }) => {
      const ctx = await browser.newContext({ baseURL: test.info().project.use.baseURL, ...(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : {}) });
      const page = await ctx.newPage();
      await setTheme(page, theme);
      await office(page, request, { fleet: TWO, maia: { enabled: true } });
      await expect(step(page, INTRO)).toBeVisible();
      const seen: string[] = [];
      for (let k = 0; k < 16; k++) {
        await page.waitForTimeout(400);
        seen.push(await card(page).locator('.tour-title').innerText());
        expect(await axeTour(page), `${theme}, ${seen.at(-1)}`).toEqual([]);
        const done = (await nextBtn(page).textContent()) === 'Done';
        await nextBtn(page).click();
        if (done) break;
      }
      expect(seen).toEqual(phone ? TWO_MAIA_STEPS.filter((t) => t !== 'Switch desks') : TWO_MAIA_STEPS);
      await ctx.close();
    });
  }
}

// Review shots, by hand: TOUR_SHOTS=<dir> npx playwright test tour.shell -g shots. The Designer's scene: Personal and Work
// (or one desk: `one`), Maia on, Files and the setup circle on, the built-in desk styles, Zen on "Misty mountains"; 1280 x
// 800, and the phone at 2x.
const SHOTS = process.env['TOUR_SHOTS'];
const NAME: Record<ThemeId, string> = { light: 'light', dusk: 'zen', dark: 'dark' };

async function shotScene(browser: Browser, request: APIRequestContext, theme: ThemeId, phone: boolean, fleet = TWO): Promise<Page> {
  const ctx = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 800 },
    deviceScaleFactor: phone ? 2 : 1,
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    if (window === window.top) (window as unknown as { __maTestDeskStyles?: unknown }).__maTestDeskStyles = [];
  });
  await setTheme(page, theme);
  // The tour off for the scene's set-up, then Take the tour, so the Zen background can be chosen first.
  const links = { forums: 'https://forums.localhost/', help: 'https://localhost/help', privacy: 'https://localhost/privacy', terms: 'https://localhost/terms', guidelines: 'https://localhost/guidelines' };
  await harness(request, { walkthrough: null, fleet, files: { enabled: true }, setupCircle: null, maia: { enabled: true }, configExtra: { links } });
  await page.addInitScript(() => {
    if (window === window.top && !localStorage.getItem('ma.tour.v1')) localStorage.setItem('ma.tour.v1', JSON.stringify({ who: 'u-test', off: true }));
  });
  await signIn(page);
  await canvasPainted(page);
  if (theme === 'dusk') {
    await accountButton(page).click();
    await openMenuSection(page, 'menu-appearance');
    await page.getByRole('radio', { name: 'Background: Misty mountains' }).click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(1500);
  }
  await expect(page.locator('.maia-launcher')).toBeVisible();
  await page.mouse.move(phone ? 2 : 4, phone ? 300 : 500);
  await page.waitForTimeout(1500);
  return page;
}

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  for (const [phone, who] of [[false, 'two'], [false, 'one'], [true, 'two']] as const) {
    test(`shots: every step, ${who} desk(s), ${NAME[theme]}${phone ? ', phone' : ''}`, async ({ browser, request }) => {
      test.skip(!SHOTS, 'TOUR_SHOTS is not set');
      mkdirSync(SHOTS!, { recursive: true });
      const page = await shotScene(browser, request, theme, phone, who === 'one' ? ONE : TWO);
      const size = `${who}-${phone ? '390' : '1280'}`;
      await page.locator('.home-mark-btn').focus();
      await page.keyboard.press('Enter');
      const row = page.locator('#mark-menu').getByRole('button', { name: 'Take the tour' });
      await page.waitForTimeout(500); // the menu's unfold, so nothing is scrolled to reach the row
      await row.focus();
      await page.keyboard.press('Enter');
      await expect(step(page, INTRO)).toBeVisible();
      for (let k = 1; k < 16; k++) {
        await page.waitForTimeout(500);
        const id = await card(page).getAttribute('data-step');
        await page.screenshot({ path: `${SHOTS}/${String(k).padStart(2, '0')}-${id}-${NAME[theme]}-${size}.png` });
        const done = (await nextBtn(page).textContent()) === 'Done';
        if (done) break;
        await nextBtn(page).click();
      }
      if (phone || who === 'one') return;
      // The last step's Done, then the account menu, with nothing of the tour and no "Plain background".
      await nextBtn(page).click();
      await expect(page.locator('.tour')).toHaveCount(0);
      await accountButton(page).click();
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${SHOTS}/20-account-menu-${NAME[theme]}-${size}.png` });
      // The note after "Don't show this again".
      await page.keyboard.press('Escape');
      await page.locator('.home-mark-btn').focus();
      await page.keyboard.press('Enter');
      await page.locator('#mark-menu').getByRole('button', { name: 'Take the tour' }).click();
      await page.getByTestId('tour-off').click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: `${SHOTS}/21-off-note-${NAME[theme]}-${size}.png` });
      // "Take the tour" in the open menu, hovered, on the Personal desk (so All desks is there too).
      await page.waitForTimeout(4500); // the note's 4.2 s
      await page.locator('#proxy-d-personal00001').evaluate((el) => (el as HTMLElement).click());
      await page.waitForTimeout(1200);
      await page.locator('.home-mark-btn').focus();
      await page.keyboard.press('Enter');
      await page.waitForTimeout(500);
      await page.locator('#mark-menu').getByRole('button', { name: 'Take the tour' }).hover();
      await page.waitForTimeout(300);
      await page.screenshot({ path: `${SHOTS}/22-take-the-tour-${NAME[theme]}-${size}.png` });
    });
  }
}
