// What the accessibility audit of 2026-11-06 found in the Desk app, fixed: single keys only on the canvas
// (WCAG 2.1.4), the canvas's focus ring, the main landmark and reading order, and the account menu's words and its
// list of keys. The unpaid notice is task 27's.
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, themeRadio, watchConsole, type ThemeId } from './helpers';

declare const __maDesk: { camera: { cam: { x: number; y: number; s: number } } };

const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

const cam = (page: Page): Promise<{ x: number; y: number; s: number }> => page.evaluate(() => ({ ...__maDesk.camera.cam }));
const viewMode = (page: Page): Promise<string> => page.evaluate(() => (JSON.parse(localStorage.getItem('ma.view.v1') ?? '{}') as { mode: string }).mode);
const shield = (page: Page): Locator => page.getByRole('button', { name: 'Privacy shield' });
const deskLabel = (page: Page): Promise<string> => page.locator('.desk-nav-label').innerText();
const blur = (page: Page): Promise<void> => page.evaluate(() => void (document.activeElement as HTMLElement | null)?.blur());

// ----- single keys (audit item 5)
test.describe('single keys act only while the canvas has focus', () => {
  // Every key that used to act from anywhere outside a field. Enter and Space too: a space comes with every dictated word.
  const KEYS = ['\\', ']', '[', '=', '+', '-', '_', '0', '1', '2', '9', ' ', 'Enter'];

  async function expectNothing(page: Page, keys: readonly string[], where: string, before: { cam: unknown; desk: string }): Promise<void> {
    for (const key of keys) await page.keyboard.press(key);
    await page.waitForTimeout(700);
    expect(await shield(page).getAttribute('aria-pressed'), where).toBe('false');
    expect(await viewMode(page), where).toBe('overview');
    expect(await cam(page), where).toEqual(before.cam);
    expect(await deskLabel(page), where).toBe(before.desk);
    await expect(page.locator('.window-layer [role="dialog"]'), where).toHaveCount(0);
  }

  test('nothing happens on the page, in the bars or in the account menu', async ({ page }) => {
    const errors = watchConsole(page);
    await signIn(page, '/?fixture=three');
    await canvasPainted(page);
    const before = { cam: await cam(page), desk: await deskLabel(page) };

    await blur(page); // as after a load, or a word dictated with nothing focused
    await expectNothing(page, KEYS, 'the page', before);
    // A control in the bars owns Enter and Space, so those press it: leave them out there.
    const chrome = KEYS.filter((k) => k !== ' ' && k !== 'Enter');
    await shield(page).focus();
    await expectNothing(page, chrome, 'the top bar', before);
    await page.getByRole('button', { name: 'Next desk' }).focus();
    await expectNothing(page, chrome, 'the bottom bar', before);
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await themeRadio(page, 'Light').focus();
    await expectNothing(page, chrome, 'the account menu', before);
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });

  test('on the canvas they work as before, after a press on it or with a desk focused', async ({ page }) => {
    const errors = watchConsole(page);
    await signIn(page, '/?fixture=three');
    await canvasPainted(page);
    const first = await deskLabel(page);

    // A press on the empty canvas gives it the keyboard, with no ring of its own.
    await page.mouse.click(5, 450);
    await expect(page.locator('.canvas-wrap')).toBeFocused();
    expect(await page.locator('.canvas-wrap').evaluate((el) => el.matches(':focus-visible'))).toBe(false);
    await page.keyboard.press('\\');
    await expect(shield(page)).toHaveAttribute('aria-pressed', 'true');
    await page.keyboard.press('\\');
    await expect(shield(page)).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press(']'); // the ring moves, and only the ring
    await page.waitForTimeout(300);
    expect(await deskLabel(page)).not.toBe(first);
    expect(await viewMode(page)).toBe('overview');
    await page.keyboard.press('Enter'); // and Enter goes into the desk it's on
    await page.waitForTimeout(700);
    expect(await viewMode(page)).toBe('desk');
    await page.keyboard.press('0');
    await page.waitForTimeout(700);
    expect(await viewMode(page)).toBe('overview');
    const s = (await cam(page)).s;
    await page.keyboard.press('=');
    await page.waitForTimeout(700);
    expect((await cam(page)).s).toBeGreaterThan(s);
    await page.keyboard.press('0');
    await page.waitForTimeout(700);

    // From a desk the keyboard is on, and from an app.
    await page.locator('.proxy-layer [tabindex="0"]').focus();
    await page.keyboard.press('2');
    await page.waitForTimeout(700);
    expect(await viewMode(page)).toBe('desk');
    await expect(page.locator('.desk-nav-label')).toContainText('Work');
    await page.getByRole('group', { name: 'Work desk' }).getByRole('button', { name: /^Notebook/ }).focus();
    await page.keyboard.press('\\');
    await expect(shield(page)).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
  });

  test('the arrows still work from the page, and bring the keyboard onto the desks', async ({ page }) => {
    await signIn(page, '/?fixture=three');
    await canvasPainted(page);
    const first = await deskLabel(page);
    await blur(page);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    expect(await deskLabel(page)).not.toBe(first);
    expect(await viewMode(page)).toBe('overview');
    const name = /^(\w+) desk, /.exec((await page.locator('.proxy-layer :focus').getAttribute('aria-label')) ?? '')?.[1];
    expect(name).toBeTruthy();
    await expect(page.locator('.desk-nav-label')).toContainText(name!);
    await page.keyboard.press('Enter'); // the desk's own button
    await page.waitForTimeout(700);
    expect(await viewMode(page)).toBe('desk');
  });

  test("a dictated sentence with nothing focused wakes no desk; a key on the canvas still does", async ({ page, request }) => {
    const desk = (deskId: string, name: string, kind: string) => ({ deskId, name, kind, state: 'stopped' });
    await harness(request, { fleet: [desk('d-personal00001', 'Personal', 'personal'), desk('d-work000000001', 'Work', 'work')] });
    const wakes = async (): Promise<number> => ((await (await request.get('/__harness')).json()) as { connects: { start: unknown }[] }).connects.filter((c) => c.start === true).length;
    await signIn(page, '/?link=real');
    await canvasPainted(page);
    await page.waitForTimeout(1000);
    expect(await wakes()).toBe(0);
    await blur(page);
    await page.keyboard.type('Go to desk 2 then 1, zoom in + and out - [ ] 0. Mark it\\ read');
    await page.waitForTimeout(1500);
    expect(await wakes()).toBe(0);
    expect(await viewMode(page)).toBe('overview');

    await focusCanvas(page);
    await page.keyboard.press('2');
    await expect.poll(wakes).toBe(1);
  });
});

// ----- the canvas's focus ring (audit item 10)
test.describe('the focus ring', () => {
  /** The ring on screen: its width, how far out its outer edge is, and the proxy's own outline. */
  const ringOf = (target: Locator) => target.evaluate((el) => {
    const after = getComputedStyle(el, '::after');
    const layer = el.closest('.proxy-layer')!;
    const s = new DOMMatrixReadOnly(getComputedStyle(layer).transform).a;
    const back = new DOMMatrixReadOnly(after.transform).a;
    const box = el.getBoundingClientRect();
    return {
      s,
      width: parseFloat(after.borderTopWidth) * back * s,
      out: -parseFloat(after.left) * s,
      across: parseFloat(after.width) * back * s - box.width,
      style: after.borderTopStyle,
      outline: getComputedStyle(el).outlineStyle,
    };
  });

  test('is 2 px with a 2 px gap on screen on apps and desks at any zoom, as on the chrome', async ({ page }) => {
    const errors = watchConsole(page);
    await signIn(page, '/?fixture=three');
    await canvasPainted(page);
    // The chrome's, for comparison.
    await page.locator('.proxy-layer [tabindex="0"]').focus();
    await page.keyboard.press('Shift+Tab');
    const chrome = await page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement!);
      return { width: cs.outlineWidth, offset: cs.outlineOffset };
    });
    expect(chrome).toEqual({ width: '2px', offset: '2px' });

    // A desk, zoomed out under 100 %.
    await page.locator('.proxy-layer [tabindex="0"]').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('-');
    await page.waitForTimeout(700);
    const desk = page.locator('.proxy-layer :focus');
    const inOverview = await ringOf(desk);
    expect(inOverview.s).toBeLessThan(1);
    // An app on a desk, over 100 %: this is where it drew 1.75 px.
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(400);
    const app = page.locator('.proxy-layer :focus');
    await expect(app).toHaveAttribute('aria-label', /^(Notebook|Browser|Chat|Agent)/);
    const onDesk = await ringOf(app);
    expect(onDesk.s).toBeGreaterThan(1);
    for (const ring of [inOverview, onDesk]) {
      expect(ring.outline).toBe('none');
      expect(ring.style).toBe('solid');
      expect(ring.width).toBeCloseTo(2, 2);
      expect(ring.out).toBeCloseTo(4, 2); // 2 px of gap, then 2 px of ring
      expect(ring.across).toBeCloseTo(8, 1);
    }
    // A keyboard edit's ring stays dashed and a little heavier, on the tile while the edit's row has the keyboard.
    const tile = page.locator(`[id="${await app.getAttribute('id')}"]`);
    await page.keyboard.press('m');
    await expect(tile).toHaveClass(/\bediting\b/);
    const editing = await ringOf(tile);
    expect(editing.style).toBe('dashed');
    expect(editing.width).toBeCloseTo(3, 2);
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  });

  for (const theme of THEMES) {
    test(`screenshot of a focused app: ${theme}`, async ({ page }) => {
      await setTheme(page, theme);
      await signIn(page, '/?fixture=one');
      await canvasPainted(page);
      await page.locator('.proxy-layer [tabindex="0"]').focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(400);
      await page.screenshot({ path: `test-results/shots/a11y-focus-app-${theme}.png` });
    });
  }
});

// ----- landmarks and reading order (the rest)
test('the desks are the main landmark, after the banner, with their controls', async ({ page }) => {
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  const main = page.getByRole('main', { name: 'Desks' });
  await expect(main).toHaveCount(1);
  await expect(main.getByRole('button', { name: /^Personal desk, / })).toHaveCount(1);
  await expect(main.getByRole('group', { name: 'Switch desk' })).toHaveCount(1);
  await expect(main.getByRole('group', { name: 'Zoom' })).toHaveCount(1);
  await expect(main.getByRole('group', { name: 'Desks' })).toHaveCount(0); // the landmark names it, once
  // The banner comes first in reading order, then the desks, then their controls.
  const order = await page.evaluate(() => {
    const at = (q: string) => document.querySelector(q)!;
    const before = (a: Element, b: Element) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    return { bannerFirst: before(at('header.topbar'), at('main')), desksBeforeBar: before(at('.proxy-layer'), at('.bottombar')) };
  });
  expect(order).toEqual({ bannerFirst: true, desksBeforeBar: true });
  await blur(page);
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => !!document.activeElement?.closest('header.topbar'))).toBe(true);
  // Painting goes by z-index, so the top bar still draws over the canvas and its ring, and over the bottom bar and
  // the bandwidth circle, which its account menu can reach.
  const z = await page.evaluate(() => ['.topbar', '.bottombar'].map((q) => Number(getComputedStyle(document.querySelector(q)!).zIndex)));
  expect(z[0]).toBeGreaterThan(Math.max(z[1]!, 11));
});

// ----- the account menu (the rest)
test.describe('the account menu', () => {
  test('opens Account settings over the office, with no "(opens in a new tab)", and lists the keyboard shortcuts', async ({ page }) => {
    const errors = watchConsole(page);
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    const button = page.getByRole('button', { name: 'Account', exact: true });
    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Account' });
    await expect(dialog.getByRole('button', { name: 'Account settings', exact: true })).toHaveAttribute('aria-haspopup', 'dialog');
    await expect(dialog).not.toContainText('opens in a new tab');
    await expect(dialog.getByRole('link', { name: 'Account', exact: true })).toHaveCount(0); // no longer named like the button

    const shortcuts = dialog.getByRole('button', { name: 'Keyboard shortcuts' });
    await expect(shortcuts).toHaveAttribute('aria-expanded', 'false');
    await expect(page.getByTestId('shortcuts')).toHaveCount(0);
    // The keyboard reaches it, as everything in the panel.
    await shortcuts.focus();
    await page.keyboard.press('Enter');
    await expect(shortcuts).toHaveAttribute('aria-expanded', 'true');
    const list = page.getByTestId('shortcuts');
    await expect(list).toContainText('These work while your desks have focus');
    const rows = list.locator('.about-row');
    await expect(rows).toHaveCount(19); // with #9's "Open a copied link on a desk"
    await expect(list).toContainText('In an app');
    // Each key on its own row, beside its words.
    const [first, second] = await rows.evaluateAll((els) => els.slice(0, 2).map((el) => el.getBoundingClientRect().top));
    expect(second! - first!).toBeGreaterThan(10);
    // Tall now, the menu draws over the bottom bar, not under it.
    const covered = await dialog.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const bottom = Math.min(r.bottom, window.innerHeight) - 12;
      return [r.right - 24, r.right - 80, r.left + 24].map((x) => !!document.elementFromPoint(x, bottom)?.closest('#account-panel'));
    });
    expect(covered).toEqual([true, true, true]);
    for (const [key, what] of [['\\', 'Privacy shield'], ['1 to 9', 'Go to a desk'], ['m', 'Move a desk or app'], ['Shift+Esc', 'Close any window']] as const) {
      await expect(rows.filter({ has: page.locator('kbd', { hasText: new RegExp(`^${key.replace(/[\\+]/g, '\\$&')}$`) }) })).toContainText(what);
    }
    for (const theme of THEMES) {
      await page.evaluate((t) => { document.documentElement.dataset['theme'] = t; }, theme);
      await page.waitForTimeout(250);
      await dialog.screenshot({ path: `test-results/shots/a11y-account-menu-${theme}.png` });
    }
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(button).toBeFocused();
    expect(errors).toEqual([]);
  });
});
