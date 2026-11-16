// The theme sliders tune the office's glass (release 6.11; the owner, Nov 16: "Yes, do it"; `theme/tune/glass.ts`). A slider's
// move lays the DOM glass live (a glass control's computed body follows it), while the canvas's tiles keep their raster until
// the slider rests, then raster once: never per input event (`__maDesk.tileRasters`, sampled every frame). The glass's
// backdrops (the frosted, bent wood) are never made again for it. This browser's copy carries the glass, so the next load
// paints it with its first frame; a copy from release 6.10, with no glass in it, gets it as the sliders' chunk lands, with no
// `/v1/me` needed. Under reduced transparency the glass's properties are laid but nothing wears them (6.10's fallback).
import { expect, test, type Page } from '@playwright/test';
import { canvasPainted, harness, openMenuSection, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const PERSONAL = 'd-personal00001';
const APPS = ['browser', 'files', 'notebook', 'agent', 'todo'];
const MIRROR = 'ma.appearance.v1';
type Hook = { __maDesk: { camera: { isMoving(): boolean }; tileRasters(): number; glassLensStats(): { ms: number; count: number } } };

/** The Personal desk on White oak with a row of icons, as `apptiles.glass.shell.spec.ts` lays it out. */
async function arrive(page: Page, theme: ThemeId, opts: { rt?: boolean } = {}): Promise<string[]> {
  const errors = watchConsole(page);
  if (opts.rt) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  }
  await page.addInitScript(() => { (window as unknown as { __maTestDeskStyles: unknown }).__maTestDeskStyles = []; });
  await page.addInitScript((d) => {
    if (window !== window.top || localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('ma.layout.v2', d);
  }, JSON.stringify({ desks: { [PERSONAL]: { id: PERSONAL, x: 0, y: 36, w: 24 + APPS.length * 92 + 8, h: 24 + 92 + 60, style: 'white-oak', items: APPS.map((app, k) => ({ id: `${PERSONAL}:${app}`, app, x: 24 + k * 92, y: 24, w: 76, h: 76 })) } }, z: [PERSONAL] }));
  await setTheme(page, theme);
  await harness(page.request, { reset: true });
  await harness(page.request, { fleet: [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }], files: { enabled: true }, todo: null });
  await signIn(page, '/?widgets=none');
  await canvasPainted(page);
  return errors;
}

const rasters = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as Hook).__maDesk.tileRasters());
const lens = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as Hook).__maDesk.glassLensStats().count);
const moving = (page: Page): Promise<boolean> => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving());
/** A glass control in the top bar (the bell's round), as drawn: its body is `--ma-glass-body-dense`'s egg. */
const glassBody = (page: Page): Promise<string> => page.locator('.topbar .icon-btn.ma-glass').first().evaluate((el) => getComputedStyle(el).backgroundImage);
const inline = (page: Page, prop: string): Promise<string> => page.evaluate((p) => document.documentElement.style.getPropertyValue(p), prop);

/** Once nothing is moving and the glass's idle work is done: the tiles' raster count holds still. */
async function still(page: Page): Promise<void> {
  await expect.poll(() => moving(page)).toBe(false);
  let n = -1;
  await expect.poll(async () => {
    const was = n;
    n = (await rasters(page)) * 1000 + (await lens(page));
    return n === was;
  }, { intervals: [400, 400, 400] }).toBe(true);
}

async function tile(page: Page, app = 'Browser'): Promise<Buffer> {
  const box = (await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: new RegExp(`^${app}`) }).boundingBox())!;
  return page.screenshot({ clip: { x: box.x - 10, y: box.y - 8, width: box.width + 20, height: box.height + 22 } });
}

async function openAppearance(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Account', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Account' })).toBeVisible();
  await openMenuSection(page, 'menu-appearance');
  await expect(page.getByRole('slider', { name: 'Blue' })).toBeEnabled();
}

/** Samples, every frame, the tiles' raster count and the DOM glass's laid body, until stopped. */
async function sample(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as Hook & { __glassSamples: { t: number; n: number; body: string }[]; __glassStop: boolean };
    w.__glassSamples = [];
    w.__glassStop = false;
    const tick = (): void => {
      w.__glassSamples.push({ t: performance.now(), n: w.__maDesk.tileRasters(), body: document.documentElement.style.getPropertyValue('--ma-glass-body-dense') });
      if (!w.__glassStop) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
const samples = (page: Page): Promise<{ t: number; n: number; body: string }[]> =>
  page.evaluate(() => {
    const w = window as unknown as { __glassSamples: { t: number; n: number; body: string }[]; __glassStop: boolean };
    w.__glassStop = true;
    return w.__glassSamples;
  });

for (const theme of ['dark', 'dusk', 'light'] as ThemeId[]) {
  test(`${theme}: a slider moves the DOM glass live, and the tiles raster once when it rests, never per input event`, async ({ page }) => {
    const errors = await arrive(page, theme);
    await openAppearance(page);
    await page.mouse.move(1000, 880);
    await still(page);
    const before = { body: await glassBody(page), tile: await tile(page), rasters: await rasters(page), lens: await lens(page) };
    expect(await inline(page, '--ma-glass-body-dense')).toBe('');

    await sample(page);
    const blue = page.getByRole('slider', { name: 'Blue' });
    const contrast = page.getByRole('slider', { name: 'Contrast' });
    await blue.focus();
    // Ten input events in quick succession (each its own `input`), Blue toward grey, then Contrast up.
    for (let i = 0; i < 6; i++) await page.keyboard.press('PageDown');
    await contrast.focus();
    for (let i = 0; i < 4; i++) await page.keyboard.press('PageUp');
    const lastPress = await page.evaluate(() => performance.now());
    await expect(blue).toHaveValue('40');
    await expect(contrast).toHaveValue('90');
    // The tiles rest at once on their raster, then raster once.
    await expect.poll(() => rasters(page), { timeout: 3000 }).toBeGreaterThan(before.rasters);
    await page.waitForTimeout(800);
    const s = await samples(page);
    const bumps = s.filter((x, i) => i > 0 && x.n !== s[i - 1]!.n);
    // Exactly one frame rastered tiles, after the last input event and the rest (250 ms), and it rastered each tile once.
    expect(bumps.map((b) => Math.round(b.t - lastPress)), JSON.stringify(bumps)).toHaveLength(1);
    expect(bumps[0]!.t).toBeGreaterThan(lastPress + 200);
    const made = bumps[0]!.n - before.rasters;
    expect(made).toBeGreaterThanOrEqual(APPS.length);
    expect(made).toBeLessThanOrEqual(APPS.length * 2); // a tile, and at most its stacked look, made beside it
    expect(await rasters(page)).toBe(bumps[0]!.n);
    // The DOM glass followed live: its laid body changed frame by frame while the keys went down, before any tile rastered.
    const live = new Set(s.filter((x) => x.t < bumps[0]!.t && x.body).map((x) => x.body));
    expect(live.size).toBeGreaterThan(1);
    // The control as drawn changed; the tile too, once; and no backdrop was made again (no colour of the sliders' is in it).
    expect(await glassBody(page)).not.toBe(before.body);
    expect((await tile(page)).equals(before.tile)).toBe(false);
    expect(await lens(page)).toBe(before.lens);
    // A further rest changes nothing.
    await page.waitForTimeout(600);
    expect(await rasters(page)).toBe(bumps[0]!.n);
    expect(errors).toEqual([]);
  });
}

test('Reset eases back and lands once: the tiles raster once at its end, and the glass is today\'s again', async ({ page }) => {
  const errors = await arrive(page, 'dark');
  const today = await (async () => {
    await page.mouse.move(1000, 880);
    await still(page);
    return { body: await glassBody(page), tile: await tile(page) };
  })();
  await openAppearance(page);
  await page.getByRole('slider', { name: 'Blue' }).focus();
  await page.keyboard.press('Home');
  await page.mouse.move(1000, 880);
  await still(page);
  const r0 = await rasters(page);
  await sample(page);
  await page.getByRole('button', { name: 'Reset blue and contrast' }).click();
  await page.mouse.move(1000, 880);
  await expect.poll(() => inline(page, '--ma-glass-body-dense')).toBe('');
  await page.waitForTimeout(800);
  const s = await samples(page);
  const bumps = s.filter((x, i) => i > 0 && x.n !== s[i - 1]!.n);
  expect(bumps, JSON.stringify(bumps.map((b) => b.n - r0))).toHaveLength(1);
  expect(await glassBody(page)).toBe(today.body);
  expect((await tile(page)).equals(today.tile)).toBe(true);
  expect(errors).toEqual([]);
});

test("this browser's copy carries the glass: the next load lays it with the first frame, before Platform says anything", async ({ page, request }) => {
  await arrive(page, 'dusk');
  await openAppearance(page);
  await page.getByRole('slider', { name: 'Blue' }).focus();
  await page.keyboard.press('Home');
  await expect.poll(async () => Object.keys((await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), MIRROR))?.flats?.dusk ?? {}).filter((k) => k.startsWith('glass.')).length).toBeGreaterThan(0);
  const laid = await inline(page, '--ma-glass-body-dense');
  expect(laid).toMatch(/^radial-gradient/);
  await harness(request, { meDelayMs: 4000 });
  // The first frame: when the glass's property first lands on <html>, nothing of the office is drawn yet (`theme/boot.ts` lays it
  // before React or the canvas run).
  await page.addInitScript(() => {
    const seen = new MutationObserver(() => {
      const v = document.documentElement?.style.getPropertyValue('--ma-glass-body-dense');
      if (!v || 'bootGlass' in window) return;
      (window as unknown as { bootGlass: unknown }).bootGlass = { v, shell: !!document.querySelector('.ma-shell'), painted: performance.getEntriesByName('ma:first-canvas-paint').length };
      seen.disconnect();
    });
    seen.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['style'] });
  });
  await page.reload();
  await expect(page.locator('.ma-shell')).toBeVisible();
  expect(await page.evaluate(() => (window as unknown as { bootGlass: unknown }).bootGlass)).toEqual({ v: laid, shell: false, painted: 0 });
  expect(await inline(page, '--ma-glass-body-dense')).toBe(laid);
  // The canvas's glass properties are never custom properties.
  expect(await page.evaluate(() => Array.from(document.documentElement.style).filter((p) => p.startsWith('--ma-tile')))).toEqual([]);
});

test('a copy from release 6.10, with no glass in it, gets its glass as the sliders\' chunk lands, without waiting for /v1/me', async ({ page, request }) => {
  await arrive(page, 'dark');
  await openAppearance(page);
  await page.getByRole('slider', { name: 'Blue' }).focus();
  await page.keyboard.press('Home');
  await expect.poll(() => page.evaluate((k) => !!localStorage.getItem(k), MIRROR)).toBe(true);
  // Make it 6.10's: the same setting, its tokens only.
  await page.evaluate((k) => {
    const m = JSON.parse(localStorage.getItem(k)!) as { flats: Record<string, Record<string, string>> };
    for (const f of Object.values(m.flats)) for (const key of Object.keys(f)) if (key.startsWith('glass.') || key.startsWith('tile')) delete f[key];
    localStorage.setItem(k, JSON.stringify(m));
  }, MIRROR);
  await harness(request, { meDelayMs: 20_000 });
  await page.reload();
  await expect(page.locator('.ma-shell')).toBeVisible();
  // The tokens are on the first frame (6.10's copy), the glass follows once the chunk is here: /v1/me is still held back.
  await expect.poll(() => inline(page, '--ma-glass-body-dense'), { timeout: 8000 }).toMatch(/^radial-gradient/);
  expect(await inline(page, '--ma-surface-world-base')).not.toBe('');
  // And the copy is rewritten with its glass, so the next load needs no chunk for it.
  await expect.poll(async () => Object.keys((await page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? 'null'), MIRROR))?.flats?.dark ?? {}).some((k) => k.startsWith('glass.'))).toBe(true);
});

test('under reduced transparency the glass is laid but nothing wears it: the solid look follows the tokens only, as in 6.10', async ({ page }) => {
  const errors = await arrive(page, 'light', { rt: true });
  await openAppearance(page);
  const before = await glassBody(page);
  expect(before).toBe('none');
  await page.getByRole('slider', { name: 'Blue' }).focus();
  await page.keyboard.press('Home');
  await expect.poll(() => inline(page, '--ma-glass-body-dense')).toMatch(/^radial-gradient/);
  expect(await glassBody(page)).toBe('none');
  expect(errors).toEqual([]);
});
