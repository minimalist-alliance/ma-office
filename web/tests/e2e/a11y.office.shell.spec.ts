// The accessibility pass of Nov 10, the office: the bottom bar draws over a window while the keyboard is on it (O2), and
// a tile its own open window covers is no Tab stop (O3), and Maia's panel adds no second banner (O4). O1 is in
// `a11y.browser.shell.spec.ts`, O6 in `notebook.shell.spec.ts`.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, type ThemeId } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

/** A window over the bottom of the screen, as a member who drags it there (a saved place is read when it opens). */
async function seedWindow(page: Page, app: string, rect: { x: number; y: number; w: number; h: number }): Promise<void> {
  await page.addInitScript(([key, r]) => localStorage.setItem('ma.windows.v1', JSON.stringify({ [key as string]: { rect: r, mode: 'window' } })), [`d-personal:${app}`, rect] as const);
}

async function openByKeyboard(page: Page, app: RegExp): Promise<void> {
  const tile = page.getByRole('group', { name: /desk$/ }).first().getByRole('button', { name: app });
  await tile.focus();
  await page.keyboard.press('Enter');
}

/** Whether the element at the middle of `target` is `target` itself (or inside it). */
const onTop = (target: ReturnType<Page['getByRole']>): Promise<boolean> =>
  target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !!hit && el.contains(hit);
  });

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${theme}: O2, the bottom bar's controls are over the Agent window while one has the keyboard, not otherwise`, async ({ page }) => {
    await setTheme(page, theme);
    await seedWindow(page, 'agent', { x: 12, y: 560, w: 1416, h: 400 });
    await signIn(page, '/?fixture=one');
    await canvasPainted(page);
    await openByKeyboard(page, /^Agent/);
    const win = page.locator('.ma-window').first();
    await expect(win).toBeVisible();
    await page.waitForTimeout(700); // its opening animation
    const zoomIn = page.getByRole('button', { name: /^Zoom in/ });
    const fit = page.getByRole('button', { name: /^Fit the desk/ });
    // Under the window by the mouse: nothing changes.
    const wb = (await win.boundingBox())!;
    const zb = (await zoomIn.boundingBox())!;
    expect(zb.x + zb.width / 2 > wb.x && zb.y + zb.height / 2 < wb.y + wb.height, JSON.stringify({ wb, zb })).toBe(true);
    await page.evaluate(() => void (document.activeElement as HTMLElement | null)?.blur());
    expect(await onTop(zoomIn), 'covered at rest').toBe(false);
    await zoomIn.focus();
    expect(await onTop(zoomIn), 'over the window with focus').toBe(true);
    await fit.focus();
    expect(await onTop(fit)).toBe(true);
    await page.screenshot({ path: `test-results/shots/a11y-bottombar-over-window-${theme}.png` });
    await page.evaluate(() => void (document.activeElement as HTMLElement | null)?.blur());
    expect(await onTop(zoomIn), 'covered again once focus leaves').toBe(false);
  });
}

test('O3, Tab does not stop on a tile its own open window covers, and does again when the window closes', async ({ page }) => {
  await seedWindow(page, 'notebook', { x: 12, y: 72, w: 1416, h: 800 });
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  await openByKeyboard(page, /^Notebook/);
  const win = page.locator('.ma-window').first();
  await expect(win).toBeVisible();
  await page.waitForTimeout(700); // its opening animation
  const tile = page.getByRole('group', { name: /desk$/ }).first().getByRole('button', { name: /^Notebook/ });
  const wb = (await win.boundingBox())!;
  const tb = (await tile.boundingBox())!;
  const covered = tb.x + tb.width / 2 > wb.x && tb.x + tb.width / 2 < wb.x + wb.width && tb.y + tb.height / 2 > wb.y && tb.y + tb.height / 2 < wb.y + wb.height;
  expect(covered, 'the window sits over its tile').toBe(true);
  {
    await expect(tile).toHaveAttribute('tabindex', '-1');
    await expect(page.locator('.proxy-layer [tabindex="0"]')).not.toHaveAttribute('aria-label', /^Notebook/);
    // Tab right round: focus is never on the covered tile.
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      expect(await page.evaluate(() => document.activeElement?.id), `Tab ${i + 1}`).not.toBe(await tile.getAttribute('id'));
    }
  }
  await page.getByRole('button', { name: /^Close/ }).first().click();
  await expect(win).toHaveCount(0);
  await expect(tile).toBeAttached();
  await tile.focus();
  await expect(tile).toHaveAttribute('tabindex', '0');
});

test('O4, Maia\'s open panel adds no second banner', async ({ page, request }) => {
  await harness(request, { maia: { enabled: true } });
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  await page.locator('.maia-launcher').click();
  await expect(page.locator('.maia-panel')).toBeVisible();
  await page.evaluate(AXE);
  const found = await page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: { id: string }[] }> } };
    const r = await w.axe.run(document, { runOnly: { type: 'rule', values: ['landmark-no-duplicate-banner', 'landmark-unique'] }, resultTypes: ['violations'] });
    return r.violations.map((v) => v.id);
  });
  expect(found).toEqual([]);
  await expect(page.locator('.maia-panel header')).toHaveCount(0);
});
