// Office backgrounds (ADR 0094): the scene behind the desks, chosen in the account menu's "Background", saved in the layout
// document's `prefs.background` (which follows the member), the theme's default with nothing chosen (Zen's first scene),
// scenes in Zen only (the owner, Nov 11: Light and Dark draw none and have no picker, and the choice stays stored), the fade, reduced motion, "Plain background", and axe on the open menu. The scenes are the
// manifest the build ships in `public/backgrounds/`.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole } from './helpers';

const AXE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
const ME = 'u-test';
const MIRROR = 'ma.prefs.background';

interface Scene { id: string; name: string }

async function manifest(request: APIRequestContext): Promise<Scene[]> {
  const cfg = (await (await request.get('/v1/client-config?app=desk-web')).json()) as { assetBase: string };
  const m = (await (await request.get(`${cfg.assetBase}backgrounds/manifest.json`)).json()) as { scenes: Scene[] };
  return m.scenes;
}

const backdrop = (page: Page) => page.locator('.ma-backdrop');
const img = (page: Page) => page.locator('.ma-backdrop picture img');
const shown = (page: Page): Promise<string | null> => page.evaluate(() => document.documentElement.getAttribute('data-backdrop'));
const mirror = (page: Page): Promise<string | null> => page.evaluate((k) => localStorage.getItem(k), MIRROR);
const savedPref = async (request: APIRequestContext): Promise<unknown> => {
  const docs = ((await (await request.get('/__harness')).json()) as { layoutDocs: Record<string, { layout: { prefs?: Record<string, unknown> } | null } | undefined> }).layoutDocs;
  return docs[ME]?.layout?.prefs?.['background'];
};

async function openMenu(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
}
const picker = (page: Page) => page.getByRole('radiogroup', { name: 'Background' });
const swatch = (page: Page, name: string) => picker(page).getByRole('radio', { name: `Background: ${name}`, exact: true });

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

test('Dusk shows the first scene with nothing chosen, after the first paint, with the picture fading in', async ({ page, request }) => {
  const errors = watchConsole(page);
  const scenes = await manifest(request);
  expect(scenes.length).toBeGreaterThanOrEqual(2);
  await setTheme(page, 'dusk');
  await signIn(page);
  // Nothing of it before the canvas's first paint: the mirror is empty on a first visit, so <html> has no scene yet.
  await canvasPainted(page);
  await expect.poll(() => shown(page)).toBe(scenes[0]!.id);
  await expect(backdrop(page)).toBeVisible();
  await expect(img(page)).toHaveAttribute('srcset', new RegExp(`backgrounds/${scenes[0]!.id}/960\\.webp 960w`));
  await expect(img(page)).toHaveClass(/\bon\b/);
  expect(await img(page).evaluate((el) => getComputedStyle(el).transitionDuration)).toBe('0.3s');
  expect(await img(page).evaluate((el) => (el as HTMLImageElement).fetchPriority)).toBe('low');
  // The AVIF source first, every width, sized to the viewport.
  const sources = await page.locator('.ma-backdrop picture source').evaluateAll((els) => els.map((e) => [(e as HTMLSourceElement).type, (e as HTMLSourceElement).sizes]));
  expect(sources).toEqual([['image/avif', '100vw']]);
  // The scrim is the theme's token, the flat top layer of the ::after's background, over the picture.
  const scrim = await backdrop(page).evaluate((el) => {
    const probe = document.createElement('div');
    probe.style.backgroundColor = getComputedStyle(document.documentElement).getPropertyValue('--ma-surface-backdrop').trim();
    document.body.append(probe);
    const want = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return [getComputedStyle(el, '::after').backgroundImage, want];
  });
  expect(scrim[1]).not.toBe('rgba(0, 0, 0, 0)');
  expect(scrim[0]!.startsWith(`linear-gradient(${scrim[1]}, ${scrim[1]})`), scrim[0]).toBe(true);
  // It multiplies the picture rather than fog it (the owner, Nov 10).
  expect(await backdrop(page).evaluate((el) => getComputedStyle(el, '::after').mixBlendMode)).toBe('multiply');
  // Its own compositor layer, as the gradient is.
  expect(await backdrop(page).evaluate((el) => getComputedStyle(el).willChange)).toBe('transform');
  // The edge bands under the wash: four gradients beneath the flat one, on the same pseudo-element.
  const layers = await backdrop(page).evaluate((el) => getComputedStyle(el, '::after').backgroundImage.split('linear-gradient(').length - 1);
  expect(layers).toBe(5);
  // Nothing chosen: the document has no `background`, the picker checks the scene on show, and the mirror has it for next time.
  await page.waitForTimeout(2600);
  expect(await savedPref(request)).toBeUndefined();
  await openMenu(page);
  await expect(swatch(page, scenes[0]!.name)).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('background-name')).toHaveText(scenes[0]!.name);
  expect(JSON.parse((await mirror(page))!)).toMatchObject({ id: scenes[0]!.id, theme: 'dusk' });
  expect(errors).toEqual([]);
});

test('Light and Dark show no scene and no Background picker', async ({ page }) => {
  for (const theme of ['light', 'dark'] as const) {
    await page.addInitScript((t) => {
      localStorage.setItem('ma.prefs.theme', JSON.stringify({ mode: t, systemDark: 'dark' }));
      localStorage.setItem('ma.theme.resolved', t);
    }, theme);
    await signIn(page);
    await canvasPainted(page);
    await page.waitForTimeout(600);
    expect(await shown(page), theme).toBeNull();
    await expect(backdrop(page)).toBeHidden();
    await expect(img(page)).toHaveCount(0);
    await openMenu(page);
    await expect(page.getByTestId('background-picker')).toHaveCount(0);
    await expect(picker(page)).toHaveCount(0);
    await page.goto('about:blank');
  }
});

test('a scene chosen in Zen is kept in Light and Dark, and comes back with Zen', async ({ page, request }) => {
  const scenes = await manifest(request);
  const pick = scenes[1]!;
  await setTheme(page, 'dusk');
  await signIn(page);
  await canvasPainted(page);
  await openMenu(page);
  await swatch(page, pick.name).click();
  await expect.poll(() => shown(page)).toBe(pick.id);
  await expect.poll(() => savedPref(request), { timeout: 8_000 }).toBe(pick.id);
  for (const label of ['Light', 'Dark']) {
    await page.getByRole('radio', { name: label, exact: true }).click();
    await expect.poll(() => shown(page), label).toBeNull();
    await expect(page.getByTestId('background-picker')).toHaveCount(0);
    expect(await savedPref(request), label).toBe(pick.id);
  }
  await page.getByRole('radio', { name: 'Zen', exact: true }).click();
  await expect.poll(() => shown(page)).toBe(pick.id);
  await expect(swatch(page, pick.name)).toHaveAttribute('aria-checked', 'true');
});

test('picking a scene shows it at once and saves prefs.background; a reload paints it before the manifest; None takes it away', async ({ page, request }) => {
  const errors = watchConsole(page);
  const scenes = await manifest(request);
  const pick = scenes[1]!;
  await setTheme(page, 'dusk');
  await signIn(page);
  await canvasPainted(page);
  await openMenu(page);
  await swatch(page, pick.name).click();
  await expect(swatch(page, pick.name)).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByTestId('background-name')).toHaveText(pick.name);
  expect(await shown(page)).toBe(pick.id);
  await expect(img(page)).toHaveAttribute('srcset', new RegExp(`backgrounds/${pick.id}/`));
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible(); // the menu stays open, so another can be tried
  await expect.poll(() => savedPref(request), { timeout: 8_000 }).toBe(pick.id);
  const m = JSON.parse((await mirror(page))!) as { id: string; theme: string; average: string; placeholder: string };
  expect(m).toMatchObject({ id: pick.id, theme: 'dusk' });
  expect(m.average).toMatch(/^#[0-9a-f]{6}$/);
  expect(m.placeholder).toMatch(/^data:image\/webp;base64,/);

  // A reload: the scene's colour and placeholder are on <html> from the mirror while the manifest is still on its way.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  await page.route('**/backgrounds/manifest.json', async (route) => {
    await gate;
    await route.continue();
  });
  await page.reload();
  await expect(page.locator('.ma-shell')).toBeVisible();
  await canvasPainted(page);
  expect(await shown(page)).toBe(pick.id);
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--ma-backdrop-image'))).toContain('data:image/webp');
  await expect(backdrop(page)).toBeVisible();
  await expect(img(page)).toHaveCount(0);
  release();
  await expect(img(page)).toHaveAttribute('srcset', new RegExp(`backgrounds/${pick.id}/`));
  await page.unroute('**/backgrounds/manifest.json');

  // None: the layer goes, and "none" is saved, so it holds in Zen, whose default is a scene.
  await openMenu(page);
  await swatch(page, 'None').click();
  await expect(swatch(page, 'None')).toHaveAttribute('aria-checked', 'true');
  expect(await shown(page)).toBeNull();
  await expect(img(page)).toHaveCount(0);
  await expect(backdrop(page)).toBeHidden(); // the scrim and its bands go with the layer
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--ma-backdrop-band'))).toBe('');
  await expect.poll(() => savedPref(request), { timeout: 8_000 }).toBe('none');
  expect(errors).toEqual([]);
});

test('what Platform has is what shows: a scene from another browser, "none" in Dusk, and an unknown id as the default, kept as it came', async ({ page, request }) => {
  const scenes = await manifest(request);
  // A new version each time, since the same ETag is read as nothing new.
  const doc = (background: string, version: number) => ({
    layoutDocs: { [ME]: { version, updatedAt: '2026-11-10T00:00:00Z', layout: { schemaVersion: 2, desks: {}, z: [], prefs: { background } } } },
  });
  await harness(request, doc(scenes[2]!.id, 3));
  await setTheme(page, 'dusk');
  await signIn(page);
  await canvasPainted(page);
  await expect.poll(() => shown(page)).toBe(scenes[2]!.id);

  await harness(request, doc('none', 4));
  await page.reload();
  await expect(page.locator('.ma-shell')).toBeVisible();
  await canvasPainted(page);
  await expect.poll(() => shown(page)).toBeNull();
  await expect(img(page)).toHaveCount(0);

  await harness(request, doc('from-a-newer-build', 5));
  await page.reload();
  await expect(page.locator('.ma-shell')).toBeVisible();
  await canvasPainted(page);
  await expect.poll(() => shown(page)).toBe(scenes[0]!.id);
  // Another preference saves the whole document: the unknown id is still there.
  await openMenu(page);
  await page.getByRole('switch', { name: 'Plain background' }).click();
  await page.getByRole('switch', { name: 'Plain background' }).click();
  await page.waitForTimeout(2600);
  expect(await savedPref(request)).toBe('from-a-newer-build');
});

test('keys: arrows move along the row, Enter and Space choose', async ({ page, request }) => {
  const scenes = await manifest(request);
  await setTheme(page, 'dusk');
  await signIn(page);
  await canvasPainted(page);
  await openMenu(page);
  await swatch(page, scenes[0]!.name).focus();
  await page.keyboard.press('ArrowRight');
  await expect(swatch(page, scenes[1]!.name)).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(swatch(page, scenes[1]!.name)).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => shown(page)).toBe(scenes[1]!.id);
  await page.keyboard.press('Home');
  await expect(swatch(page, 'None')).toBeFocused();
  await page.keyboard.press(' ');
  await expect(swatch(page, 'None')).toHaveAttribute('aria-checked', 'true');
  await expect.poll(() => shown(page)).toBeNull();
  await page.keyboard.press('End');
  await expect(swatch(page, scenes[scenes.length - 1]!.name)).toBeFocused();
  // One tab stop: Tab leaves the row.
  await page.keyboard.press('Tab');
  expect(await page.evaluate(() => document.activeElement?.getAttribute('role'))).not.toBe('radio');
  // The swatches are 44 x 25, a 16:9 picture each.
  const box = await swatch(page, scenes[0]!.name).boundingBox();
  expect(box?.width).toBe(44);
  expect(box?.height).toBe(25);
});

test('reduced motion: no fade', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setTheme(page, 'dusk');
  await signIn(page);
  await canvasPainted(page);
  await expect(img(page)).toHaveClass(/\bon\b/);
  expect(await img(page).evaluate((el) => [getComputedStyle(el).transitionDuration, getComputedStyle(el).opacity])).toEqual(['0s', '1']);
});

test('while a scene shows, a focus ring over the ground has its halo, and the active desk is drawn again with its own', async ({ page, request }) => {
  const scenes = await manifest(request);
  // Zen starts on its scene, so the member has chosen None before this load: no halo has been drawn yet (a drawn one is cached).
  await harness(request, { layoutDocs: { [ME]: { version: 3, updatedAt: '2026-11-10T00:00:00Z', layout: { schemaVersion: 2, desks: {}, z: [], prefs: { background: 'none' } } } } });
  await setTheme(page, 'dusk');
  await signIn(page);
  await canvasPainted(page);
  await expect.poll(() => shown(page)).toBeNull();
  // The ring is a proxy's ::after under :focus-visible, which the keyboard gives it: Tab from the canvas lands on the first
  // proxy in the reading order. [class, border width, box shadow] of whatever has focus.
  const ringOf = () => page.evaluate(() => {
    const el = document.activeElement as HTMLElement;
    return [el.className, getComputedStyle(el, '::after').borderTopWidth, getComputedStyle(el, '::after').boxShadow];
  });
  const rasters = () => page.evaluate(() => (window as unknown as { __maDesk: { panelRasters: () => number } }).__maDesk.panelRasters());
  await focusCanvas(page);
  await page.keyboard.press('Tab');
  expect(await ringOf()).toEqual(['proxy', '2px', 'none']);
  const before = await rasters();
  await openMenu(page);
  await swatch(page, scenes[0]!.name).click();
  await expect.poll(() => shown(page)).toBe(scenes[0]!.id);
  await page.keyboard.press('Escape');
  await focusCanvas(page);
  await page.keyboard.press('Tab');
  const ring = await ringOf();
  expect(ring[0]).toBe('proxy');
  expect(ring[2]).toMatch(/0px 0px 0px 1px$/);
  // The active desk's panel was cut again, once, with the halo outside its ring.
  await expect.poll(rasters).toBeGreaterThan(before);
  const bar = page.getByRole('button', { name: 'Zoom out' });
  await bar.focus();
  expect(await bar.evaluate((el) => getComputedStyle(el).boxShadow)).toMatch(/0px 0px 0px 5px$/);
});

test('no text sits on bare ground: the bars\' pills stay near opaque over a scene', async ({ page, request }) => {
  const scenes = await manifest(request);
  await setTheme(page, 'dusk');
  await signIn(page, '/?fixture=three');
  await canvasPainted(page);
  await expect.poll(() => shown(page)).toBe(scenes[0]!.id);
  // The alpha of a computed colour: rgb() is 1, rgba() and color() carry it last.
  const alphaOf = (sel: string) => page.locator(sel).evaluate((el) => {
    const nums = getComputedStyle(el).backgroundColor.match(/[\d.]+/g) ?? [];
    return nums.length >= 4 ? Number(nums[nums.length - 1]) : 1;
  });
  for (const sel of ['.hints', '.desk-nav', '.zoom-ctl']) {
    await expect(page.locator(sel), sel).toHaveCount(1);
    expect(await alphaOf(sel), sel).toBeGreaterThanOrEqual(0.9);
  }
});

test('"Plain background" hides the scene with the gradient, and axe finds nothing in the open menu', async ({ page, request }) => {
  const errors = watchConsole(page);
  const scenes = await manifest(request);
  await setTheme(page, 'dusk');
  await signIn(page);
  await canvasPainted(page);
  await expect.poll(() => shown(page)).toBe(scenes[0]!.id);
  await openMenu(page);
  await expect(picker(page)).toBeVisible();
  expect(await axe(page)).toEqual([]);
  await page.getByRole('switch', { name: 'Plain background' }).click();
  await expect(backdrop(page)).toBeHidden();
  expect(await shown(page)).toBe(scenes[0]!.id); // still the member's scene, for when the switch goes back
  await page.getByRole('switch', { name: 'Plain background' }).click();
  await expect(backdrop(page)).toBeVisible();
  expect(errors).toEqual([]);
});
