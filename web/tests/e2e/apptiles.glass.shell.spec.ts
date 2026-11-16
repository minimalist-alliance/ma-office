// The app tiles' glass (the owner's pick C, Nov 16: "I want C restrained for the app tiles"), on by default, and its fallback:
// under reduced transparency, or more contrast, an icon's tile is the solid tile, live, the same pixels every time, and no
// glass work runs; Maia's bubble wears the office's CSS glass, and its own look under the fallback. On the mock desk.
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, watchConsole } from './helpers';

const PERSONAL = 'd-personal00001';
const APPS = ['browser', 'files', 'notebook', 'agent', 'courier', 'todo'];
type Hook = { __maDesk: { camera: { isMoving(): boolean }; glassLensStats(): { ms: number; count: number } } };

const media = (cdp: CDPSession, f: { rt?: boolean; contrast?: boolean }): Promise<unknown> =>
  cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: f.rt ? 'reduce' : 'no-preference' }, { name: 'prefers-contrast', value: f.contrast ? 'more' : 'no-preference' }] });

async function arrive(page: Page, style: string, first: { rt?: boolean; contrast?: boolean } = {}): Promise<{ errors: string[]; cdp: CDPSession }> {
  const errors = watchConsole(page);
  // The media as the office first sees it: set before it loads, so its first raster is already the right face.
  const cdp = await page.context().newCDPSession(page);
  await media(cdp, first);
  await page.addInitScript(() => { (window as unknown as { __maTestDeskStyles: unknown }).__maTestDeskStyles = []; });
  await page.addInitScript((d) => {
    if (window !== window.top || localStorage.getItem('test.seeded') || !(location.pathname === '/auth/callback' || localStorage.getItem('ma-desk-web-refresh') || sessionStorage.getItem('ma-desk-web-refresh'))) return;
    localStorage.setItem('test.seeded', '1');
    localStorage.setItem('ma.layout.v2', d);
  }, JSON.stringify({ desks: { [PERSONAL]: { id: PERSONAL, x: 0, y: 36, w: 24 + 6 * 92 + 8, h: 24 + 92 + 60, style, items: APPS.map((app, k) => ({ id: `${PERSONAL}:${app}`, app, x: 24 + k * 92, y: 24, w: 76, h: 76 })) } }, z: [PERSONAL] }));
  await setTheme(page, 'light');
  await harness(page.request, { reset: true });
  await harness(page.request, { fleet: [{ deskId: PERSONAL, name: 'Personal', kind: 'personal', state: 'running' }], files: { enabled: true }, todo: null, maia: { enabled: true } });
  await signIn(page, '/?widgets=none');
  await canvasPainted(page);
  return { errors, cdp };
}

const lens = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as Hook).__maDesk.glassLensStats().count);

/** The Browser's tile and its shadow, once the canvas is at rest and the glass's idle work (if any) is done. */
async function tile(page: Page): Promise<Buffer> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving())).toBe(false);
  let n = -1;
  await expect.poll(async () => {
    const was = n;
    n = await lens(page);
    return n === was;
  }, { intervals: [300, 300, 300] }).toBe(true);
  await page.waitForTimeout(300);
  const box = (await page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Browser/ }).boundingBox())!;
  await page.mouse.move(2, 890);
  return page.screenshot({ clip: { x: box.x - 10, y: box.y - 8, width: box.width + 20, height: box.height + 22 } });
}

test('an icon\'s tile is glass by default; reduced transparency or more contrast gives the solid tile, live and the same every time', async ({ page }) => {
  const { errors, cdp } = await arrive(page, 'white-oak', { rt: true });
  expect(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches)).toBe(true);
  const solid = await tile(page);
  // Under the fallback no tile's backdrop is made: there's no glass to bend the wood.
  const before = await lens(page);
  expect(before).toBe(0);

  await media(cdp, {});
  const glass = await tile(page);
  expect(glass.equals(solid)).toBe(false);
  // On White oak each tile's glass bends the wood under it: made in idle time after the redraw.
  expect(await lens(page)).toBeGreaterThan(before);

  await media(cdp, { rt: true });
  expect((await tile(page)).equals(solid)).toBe(true);
  await media(cdp, {});
  expect((await tile(page)).equals(glass)).toBe(true);

  // More contrast: every desk is the flat one, and the tile is the solid one on it, with or without reduced transparency.
  await media(cdp, { contrast: true });
  const flat = await tile(page);
  const made = await lens(page);
  await media(cdp, { contrast: true, rt: true });
  expect((await tile(page)).equals(flat)).toBe(true);
  expect(await lens(page)).toBe(made);
  expect(errors).toEqual([]);
});

test('Maia\'s bubble wears the office\'s glass, and its own look under reduced transparency or more contrast', async ({ page }) => {
  const { errors, cdp } = await arrive(page, 'plain');
  const bubble = page.locator('.maia-bubble');
  await expect(bubble).toBeVisible();
  const look = (): Promise<{ bg: string; shadow: string; before: string; after: string }> =>
    bubble.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundImage, shadow: cs.boxShadow, before: getComputedStyle(el, '::before').content, after: getComputedStyle(el, '::after').backgroundImage };
    });
  const glass = await look();
  expect(glass.bg).toMatch(/linear-gradient.*radial-gradient/);
  expect(glass.after).toMatch(/^conic-gradient/);
  expect(glass.before).not.toBe('none');
  expect(glass.shadow).toMatch(/inset/);
  for (const f of [{ rt: true }, { contrast: true }]) {
    await media(cdp, f);
    const solid = await look();
    expect(solid.bg, JSON.stringify(f)).toBe('none');
    expect(solid.before).toBe('none');
    // The bubble it was: the overlay's surface, a hairline, the menu's lift.
    expect(await bubble.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toMatch(/^rgba\(0, 0, 0, 0\)$/);
    expect(solid.shadow).not.toMatch(/inset/);
  }
  expect(errors).toEqual([]);
});
