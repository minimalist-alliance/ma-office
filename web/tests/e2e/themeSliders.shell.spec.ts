// The theme sliders under the account menu's Theme (the owner, Nov 14; his pick of the Designer's sheet: blue from grey to
// today's, the sheet's contrast range; `chrome/ThemeSliders.tsx`, `theme/tune/`). One setting for the account, read from
// `/v1/me` `appearance` and saved with `PUT /v1/me/appearance` (ma-platform contract appearance.md; the harness's
// `appearance.mjs`), shared with the Forums. At the default nothing is laid: today's office exactly. A move lays the
// colours live, on <html> as custom properties and on the canvas, in every theme; this browser's copy paints the next load
// with its first frame; signing out takes them away. Keyboard, labels and the values read out; axe on the open menu.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { THEMES } from '../../src/theme/tokens';
import { canvasPainted, harness, setTheme, signIn, watchConsole, type ThemeId, openMenuSection } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const ME = 'u-test';
const MIRROR = 'ma.appearance.v1';
const WORLD = '--ma-surface-world-base';

declare const __maDesk: { camera: { dpr(): number; getStage(): { getLayers(): { getCanvas(): { getContext(): { _context: CanvasRenderingContext2D } } }[] } } };

const menu = (page: Page): Locator => page.getByRole('dialog', { name: 'Account' });
const blue = (page: Page): Locator => menu(page).getByRole('slider', { name: 'Blue' });
const contrast = (page: Page): Locator => menu(page).getByRole('slider', { name: 'Contrast' });
const reset = (page: Page): Locator => menu(page).getByRole('button', { name: 'Reset blue and contrast' });

async function openMenu(page: Page): Promise<void> {
  if (!(await menu(page).count())) {
    await page.getByRole('button', { name: 'Account', exact: true }).click();
    await expect(menu(page)).toBeVisible();
  }
  await openMenuSection(page, 'menu-appearance'); // the sliders are under Appearance since the owner's Nov 16 tidy
  await expect(blue(page)).toBeEnabled();
}

/** The inline custom property on <html> (what the sliders lay), or '' when none is set. */
const inline = (page: Page, prop: string): Promise<string> => page.evaluate((p) => document.documentElement.style.getPropertyValue(p), prop);
/** Every --ma- custom property set inline on <html>. */
const inlineProps = (page: Page): Promise<string[]> =>
  page.evaluate(() => Array.from(document.documentElement.style).filter((p) => p.startsWith('--ma-') && !p.startsWith('--ma-backdrop')));
const mirror = (page: Page): Promise<{ who: string; blue: number; contrast: number; flats: Record<string, Record<string, string>> } | null> =>
  page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), MIRROR);
const puts = async (request: APIRequestContext): Promise<{ body: string; status: number }[]> =>
  ((await (await request.get('/__harness')).json()) as { appearancePuts?: { body: string; status: number }[] }).appearancePuts ?? [];

/** The Personal desk's surface on the canvas, as [r, g, b], from a box in its open middle (theme.shell.spec.ts's place). */
const PERSONAL = 'd-personal00001';
const fleet = [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }];
const deskRgb = (page: Page): Promise<[number, number, number]> =>
  page.evaluate((id) => {
    const { camera } = __maDesk;
    const el = document.getElementById(`proxy-${id}`)!.getBoundingClientRect();
    const stageBox = document.querySelector('.konvajs-content')!.getBoundingClientRect();
    const d = camera.dpr();
    const x = Math.round((el.left - stageBox.left + el.width * 0.25) * d);
    const y = Math.round((el.top - stageBox.top + el.height * 0.62) * d);
    const { data } = camera.getStage().getLayers()[0]!.getCanvas().getContext()._context.getImageData(x, y, Math.round(el.width * 0.5 * d), 12);
    const s = [0, 0, 0];
    for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) s[c] = s[c]! + data[i + c]!;
    const n = data.length / 4;
    return s.map((v) => Math.round(v / n)) as [number, number, number];
  }, PERSONAL);

async function axe(page: Page): Promise<string[]> {
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    interface Rule { id: string; nodes: { target: string[] }[] }
    const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Rule[] }> } };
    const r = await w.axe.run({ include: ['#account-panel'] }, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] }, resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test('at the default: two labelled sliders, nothing laid, nothing kept, nothing sent', async ({ page, request }) => {
  const errors = watchConsole(page);
  await signIn(page);
  await canvasPainted(page);
  await openMenu(page);
  await expect(blue(page)).toHaveValue('100');
  await expect(blue(page)).toHaveAttribute('aria-valuetext', '100 percent, the default');
  await expect(contrast(page)).toHaveValue('50');
  await expect(contrast(page)).toHaveAttribute('aria-valuetext', '50 percent, the default');
  await expect(reset(page)).toHaveCount(0);
  // Under the theme picker, before Background.
  const order = await menu(page).evaluate((m) => {
    const all = Array.from(m.querySelectorAll('[aria-label="Theme"], [data-testid="theme-tune"]'));
    return all.map((e) => e.getAttribute('data-testid') ?? 'theme');
  });
  expect(order).toEqual(['theme', 'theme-tune']);
  await expect(menu(page).getByText('Plain background')).toHaveCount(0);
  expect(await inlineProps(page)).toEqual([]);
  expect(await mirror(page)).toBeNull();
  expect(await puts(request)).toEqual([]);
  expect(await axe(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('the keyboard moves them live: the CSS and the canvas follow, the value is read out, and one save goes when it rests', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { fleet });
  await setTheme(page, 'dark');
  await signIn(page);
  await canvasPainted(page);
  // Dark's desk is a cool slate on the canvas: its blue channel above its red.
  const [r0, , b0] = await deskRgb(page);
  expect(b0).toBeGreaterThan(r0);
  await openMenu(page);
  await blue(page).focus();
  await page.keyboard.press('Home');
  await expect(blue(page)).toHaveValue('0');
  await expect(blue(page)).toHaveAttribute('aria-valuetext', '0 percent, grey');
  // The ground's blue is gone: an exact grey, laid inline over themes.css.
  await expect.poll(() => inline(page, WORLD)).toMatch(/^#([0-9A-F]{2})\1\1$/);
  // And the canvas drew the desk again, grey now.
  await expect.poll(async () => { const [r, g, b] = await deskRgb(page); return Math.max(Math.abs(r - b), Math.abs(g - b)); }).toBeLessThanOrEqual(1);
  await expect(reset(page)).toBeVisible();
  // Then contrast, to its top: the hairlines strengthen.
  await contrast(page).focus();
  await page.keyboard.press('End');
  await expect(contrast(page)).toHaveValue('100');
  await expect(contrast(page)).toHaveAttribute('aria-valuetext', '100 percent, sharper');
  await expect.poll(() => inline(page, '--ma-border-hairline')).toMatch(/^rgba\(\d+, \d+, \d+, 0\.12\)$/);
  // One save, once the slider rested, with both values.
  await expect.poll(async () => (await puts(request)).length, { timeout: 4000 }).toBe(1);
  expect(JSON.parse((await puts(request))[0]!.body)).toEqual({ blue: 0, contrast: 100 });
  const m = await mirror(page);
  expect(m).toMatchObject({ who: ME, blue: 0, contrast: 100 });
  expect(Object.keys(m!.flats).sort()).toEqual(['dark', 'dusk', 'light']);
  expect(await axe(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('every theme takes its own colours, and a theme switch swaps them in the same frame', async ({ page }) => {
  await setTheme(page, 'light');
  await signIn(page);
  await canvasPainted(page);
  await openMenu(page);
  await blue(page).focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('PageDown');
  await expect(blue(page)).toHaveValue('40');
  await expect.poll(async () => (await mirror(page))?.blue).toBe(40);
  const flats = (await mirror(page))!.flats;
  for (const [id, label] of [['dusk', /^(Dusk|Zen)$/], ['dark', 'Dark'], ['light', 'Light']] as [ThemeId, string | RegExp][]) {
    await menu(page).getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: label }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', id);
    // The laid value is this theme's, not the last one's, and it isn't today's.
    await expect.poll(() => inline(page, WORLD)).toBe(flats[id]!['surface.worldBase']);
    expect(flats[id]!['surface.worldBase']).not.toBe(THEMES[id].surface.worldBase);
    expect(await axe(page)).toEqual([]);
  }
});

test('the account setting from /v1/me is shown at sign-in, and this browser paints it with the next first frame', async ({ page, request }) => {
  await harness(request, { appearanceDocs: { [ME]: { blue: 20, contrast: 70, updatedAt: '2026-11-14T20:00:00Z' } } });
  await setTheme(page, 'dusk');
  await signIn(page);
  await canvasPainted(page);
  await expect.poll(() => inline(page, WORLD)).not.toBe('');
  await openMenu(page);
  await expect(blue(page)).toHaveValue('20');
  await expect(contrast(page)).toHaveValue('70');
  expect(await puts(request)).toEqual([]);
  const laid = await inline(page, WORLD);
  await expect.poll(async () => (await mirror(page))?.flats['dusk']?.['surface.worldBase']).toBe(laid);
  // The next load, with `/v1/me` held back: this browser's copy has laid the same value before Platform says anything.
  await harness(request, { meDelayMs: 4000 });
  await page.reload();
  await expect(page.locator('.ma-shell')).toBeVisible();
  expect(await inline(page, WORLD)).toBe(laid);
  expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dusk');
});

test('Reset eases both back to the default, which lays nothing and saves the default', async ({ page, request }) => {
  await harness(request, { appearanceDocs: { [ME]: { blue: 0, contrast: 0, updatedAt: '2026-11-14T20:00:00Z' } } });
  await signIn(page);
  await canvasPainted(page);
  await openMenu(page);
  await expect(blue(page)).toHaveValue('0');
  await reset(page).click();
  await expect(blue(page)).toHaveValue('100');
  await expect(contrast(page)).toHaveValue('50');
  await expect(reset(page)).toHaveCount(0);
  await expect.poll(() => inlineProps(page)).toEqual([]);
  await expect.poll(async () => (await puts(request)).map((p) => JSON.parse(p.body)), { timeout: 4000 }).toEqual([{ blue: 100, contrast: 50 }]);
  await expect.poll(() => mirror(page)).toBeNull();
});

test('signing out takes the colours and this browser’s copy away', async ({ page, request }) => {
  await harness(request, { appearanceDocs: { [ME]: { blue: 10, contrast: 80, updatedAt: '2026-11-14T20:00:00Z' } } });
  await signIn(page);
  await canvasPainted(page);
  await expect.poll(() => inline(page, WORLD)).not.toBe('');
  await openMenu(page);
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect.poll(() => inlineProps(page)).toEqual([]);
  expect(await mirror(page)).toBeNull();
});

test('a failed save keeps what the member chose here, and a Platform without the route changes nothing else', async ({ page, request }) => {
  await harness(request, { appearanceFail: { status: 503, times: 1 } });
  await signIn(page);
  await canvasPainted(page);
  await openMenu(page);
  await contrast(page).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(contrast(page)).toHaveValue('49');
  // Refused once, then tried again after a few seconds, and kept.
  await expect.poll(async () => (await puts(request)).map((p) => p.status), { timeout: 9000 }).toEqual([503, 200]);
  await expect(contrast(page)).toHaveValue('49');
});
