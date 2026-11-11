// A finger on phones and tablets (LS-40, LS-41 of the launch sweep): every control in the office's bars, the account
// menu and the Browser window is a target of 44 px or more, measured as a press lands (elementFromPoint), so a target
// that grows round its button invisibly counts. On a phone held upright the Browser's address keeps the first row; on
// a phone on its side the window takes the whole screen and the page most of its height. A mouse sees no change.
// On a phone held upright an app opens in its desk's carousel (the Thumb row), full screen, so that's where it's measured.
// Chromium with each device's size, touch and mobile viewport (the iPhone and iPad profiles are WebKit's own sizes).
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const DEVICES = [
  ['iphone15-portrait', { width: 393, height: 659 }],
  ['iphone15-landscape', { width: 734, height: 343 }],
  ['pixel7-portrait', { width: 412, height: 839 }],
  ['pixel7-landscape', { width: 863, height: 360 }],
  ['ipadpro11-portrait', { width: 834, height: 1194 }],
] as const;

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

/** Every control on screen whose target, from its centre out along each axis, is under 44 px, as `name WxH`. */
function smallTargets(page: Page, within = 'body'): Promise<string[]> {
  return page.evaluate((root) => {
    const sel = 'button, a[href], input, select, textarea, [role=button], [role=radio], [role=menuitem], [tabindex]:not([tabindex="-1"])';
    const out: string[] = [];
    for (const el of document.querySelector(root)!.querySelectorAll<HTMLElement>(sel)) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2 || getComputedStyle(el).visibility === 'hidden') continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      const on = (x: number, y: number): boolean => {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) return false;
        const h = document.elementFromPoint(x, y);
        return !!h && (h === el || el.contains(h));
      };
      if (!on(cx, cy)) continue; // covered, or off screen: not a target now
      let [l, rt, t, b] = [0, 0, 0, 0];
      while (l < 30 && on(cx - l - 1, cy)) l++;
      while (rt < 30 && on(cx + rt + 1, cy)) rt++;
      while (t < 30 && on(cx, cy - t - 1)) t++;
      while (b < 30 && on(cx, cy + b + 1)) b++;
      const [w, h] = [l + rt + 1, t + b + 1];
      if (w < 44 || h < 44) out.push(`${el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName} ${w}x${h}`);
    }
    return out;
  }, within);
}

async function openBrowser(page: Page): Promise<void> {
  await page.request.post('/__harness', { data: { simpleView: null } });
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await page.evaluate('window.__maDeskMock.simple.serves = true');
  await page.evaluate(`window.__maDeskMock.setTabs([
    { tabId: 't1', url: 'https://example.org/a/long/path', title: 'Example page', loading: false, active: true, canGoBack: true, canGoForward: false },
    { tabId: 't2', url: 'https://example.com/', title: 'Second', loading: false, active: false, canGoBack: false, canGoForward: false }])`);
  await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Browser/ }).evaluate((el) => (el as HTMLButtonElement).click());
  await expect(page.getByTestId('browser-tab')).toHaveCount(2);
  await expect(page.getByTestId('browser-simple')).toBeVisible();
  await page.waitForTimeout(400); // the window's FLIP in
}

const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;

/**
 * The switch's line, as drawn: whether its "·" shows with none of its sentence beside it (the lone "· Undo" a phone
 * showed), and how wide its sentence is (1 px when it's hidden for screen readers). A character shows if a press at its
 * middle lands on what holds it, which words hidden by a clip-path or cut by an ellipsis don't take.
 */
function lineDrawn(page: Page): Promise<{ loneDot: boolean; words: number }> {
  return page.evaluate(() => {
    const line = document.querySelector('[data-testid="browser-simple-line"]');
    const words = line?.querySelector('.br-line-text');
    if (!line || !words) return { loneDot: false, words: 0 };
    const shows = (node: Text, at: number): boolean => {
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + 1);
      const r = range.getBoundingClientRect();
      const hit = r.width < 1 ? null : document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      const holder = node.parentElement;
      return !!hit && !!holder && (hit === holder || holder.contains(hit));
    };
    const texts: Text[] = [];
    const walk = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) texts.push(n as Text);
    const dot = texts.find((t) => t.data.includes('·'));
    const sentence = texts.find((t) => words.contains(t) && t.data.trim() !== '' && !t.data.includes('·'));
    const loneDot = !!dot && shows(dot, dot.data.indexOf('·')) && !(sentence && shows(sentence, 0));
    return { loneDot, words: words.getBoundingClientRect().width };
  });
}

for (const [name, viewport] of DEVICES) {
  test.describe(name, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });
    const phone = viewport.width < 600;
    const sideways = viewport.height <= 480;
    const where = phone ? '[data-testid="carousel-stage"]' : '[data-testid="window-browser"]';

    for (const theme of THEMES) {
      test(`${theme}: the bars and the Browser window, every target 44 px`, async ({ page }) => {
        const errors = watchConsole(page);
        await setTheme(page, theme);
        await openBrowser(page);
        const win = page.getByRole('dialog', { name: /Browser/ });
        expect(await smallTargets(page, where)).toEqual([]);
        await expect(win.getByRole('button', { name: phone ? 'Back from Browser' : 'Close Browser' })).toBeInViewport({ ratio: 1 });

        const address = await box(page, '.address');
        const view = await box(page, '.br-view');
        if (phone) {
          // The address has the first row; the view switch and the quality menu go to a second, at its end.
          expect(address.width).toBeGreaterThanOrEqual(200);
          const mode = await box(page, '.br-mode');
          expect(mode.y).toBeGreaterThanOrEqual(address.y + address.height);
          expect(mode.x + mode.width).toBeLessThanOrEqual(viewport.width);
        }
        if (sideways) {
          // The whole screen, and the page has most of it.
          expect(await box(page, '[data-testid="window-browser"]')).toEqual({ x: 0, y: 0, width: viewport.width, height: viewport.height });
          expect(view.height).toBeGreaterThanOrEqual(viewport.height * 0.58);
        }

        // The real page: the quality menu shows beside the switch, and it's a full target too. Under 720 px of bar it's in
        // More (#9), which is then the target.
        await page.getByTestId('browser-simple-off').click();
        await expect(win.getByRole('button', viewport.width < 720 ? { name: 'More', exact: true } : { name: /Picture quality/ })).toBeInViewport({ ratio: 1 });
        expect(await smallTargets(page, where)).toEqual([]);
        // The switch's line ("Real page here from now on · Undo") shows now: upright, it goes to the second row too.
        if (!sideways) expect((await box(page, '.address')).width).toBeGreaterThanOrEqual(phone ? 200 : 280);
        // On its side it keeps one row, and the line (its words hidden, its Undo a 44 px target) mustn't squeeze the address.
        if (sideways) expect((await box(page, '.address')).width).toBeGreaterThanOrEqual(160);
        // Its "·" goes with its sentence: never "· Undo" on its own.
        expect((await lineDrawn(page)).loneDot).toBe(false);
        await page.screenshot({ path: `test-results/shots/touch-${name}-${theme}-browser.png` });
        expect(errors).toEqual([]);
      });
    }

    test('the office\'s bars and the account menu', async ({ page }) => {
      await signIn(page, '/');
      await canvasPainted(page);
      expect(await smallTargets(page, '.ma-shell')).toEqual([]);
      await page.getByRole('button', { name: 'Account', exact: true }).click();
      await expect(page.locator('#account-panel')).toBeVisible();
      expect(await smallTargets(page, '#account-panel')).toEqual([]);
      await page.screenshot({ path: `test-results/shots/touch-${name}-menu.png` });
    });
  });
}

// Narrower on its side (from 641 px, where the words go for screen readers on a phone held upright, to 700): the sentence
// would be a sliver ("R" at 641) or two letters ("Re…" at 667), with the "·" after it. The icon and Undo show, as upright.
for (const viewport of [{ width: 641, height: 360 }, { width: 667, height: 375 }]) {
  test.describe(`a phone on its side, ${viewport.width} px`, () => {
    test.use({ viewport, hasTouch: true, isMobile: true });
    for (const theme of THEMES) test(`${theme}: the switch's line, no sliver of its sentence and no "·" without it`, async ({ page }) => {
      await setTheme(page, theme);
      await openBrowser(page);
      await page.getByTestId('browser-simple-off').click();
      await expect(page.getByTestId('browser-simple-line-action')).toBeInViewport({ ratio: 1 });
      const drawn = await lineDrawn(page);
      expect(drawn.loneDot).toBe(false);
      expect(drawn.words).toBeLessThanOrEqual(1); // hidden for screen readers, not cut to a letter
      await expect(page.getByTestId('browser-simple-line')).toHaveText('Real page here from now on · Undo');
      expect((await box(page, '.address')).width).toBeGreaterThanOrEqual(160);
      expect(await smallTargets(page, '[data-testid="window-browser"]')).toEqual([]);
      await page.screenshot({ path: `test-results/shots/touch-side-${viewport.width}-${theme}-browser.png` });
    });
  });
}

test('a mouse sees no change: the window\'s controls and the Browser\'s bar are as they were', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openBrowser(page);
  expect(await box(page, '.window-controls button[aria-label^="Close"]')).toMatchObject({ width: 30, height: 30 });
  expect((await box(page, '.address')).height).toBe(32);
  expect((await box(page, '.br-tab')).height).toBe(30);
  expect((await box(page, '.br-mode button')).height).toBe(26);
  expect((await box(page, '.ma-window.full')).y).toBe(72);
});
