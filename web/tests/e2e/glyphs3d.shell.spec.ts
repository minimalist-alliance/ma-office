// The app glyphs in the DOM (`AppGlyph`, `chrome/icons.tsx`) are the canvas's own drawing (`drawGlyph`, the MA mark's 3D finish,
// the owner's pick, Nov 12): a small canvas at the screen's pixel density, hidden from assistive tech as the SVG was, drawn
// again when the theme changes and when the density does (a window moved to another screen, or the page zoomed).
import { expect, test, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, signIn, watchConsole } from './helpers';

/** The canvas's backing size and a digest of its pixels, and how much of it is inked. */
function look(glyph: Locator): Promise<{ w: number; h: number; cssW: number; digest: string; inked: number }> {
  return glyph.evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const d = c.getContext('2d')!.getImageData(0, 0, c.width, c.height).data;
    let inked = 0;
    let hash = 0;
    for (let i = 0; i < d.length; i += 1) {
      hash = (hash * 31 + d[i]!) >>> 0;
      if (i % 4 === 3 && d[i]! > 128) inked += 1;
    }
    return { w: c.width, h: c.height, cssW: c.offsetWidth, digest: hash.toString(16), inked: inked / (c.width * c.height) };
  });
}

async function openNotebook(page: Page): Promise<Locator> {
  const tile = page.getByRole('group', { name: 'Personal desk' }).getByRole('button', { name: /^Notebook/ });
  await tile.focus();
  await page.keyboard.press('Enter');
  const win = page.getByRole('dialog', { name: /Notebook/ });
  await expect(win).toBeVisible();
  return win;
}

test('a window\'s glyph is the canvas\'s drawing: hidden from assistive tech, at the screen\'s density, redrawn on a theme or density change', async ({ page, request }) => {
  const errors = watchConsole(page);
  await harness(request, { reset: true });
  // The theme follows the system here, so the test can move it with no menu.
  await page.addInitScript(() => {
    if (window !== window.top) return;
    localStorage.setItem('ma.prefs.theme', JSON.stringify({ mode: 'system', systemDark: 'dark' }));
  });
  // Chromium's density emulation changes devicePixelRatio but fires no `change` on a `resolution` query, as a real move to
  // another screen does: keep the page's `resolution` queries, so the test can fire what the browser would.
  await page.addInitScript(() => {
    const own = window.matchMedia.bind(window);
    const kept: MediaQueryList[] = [];
    window.matchMedia = (q: string) => {
      const mq = own(q);
      if (q.includes('resolution')) kept.push(mq);
      return mq;
    };
    (window as unknown as { __screenMoved: () => void }).__screenMoved = () => kept.forEach((mq) => mq.dispatchEvent(new Event('change')));
  });
  await page.emulateMedia({ colorScheme: 'light' });
  await signIn(page, '/?fixture=one');
  await canvasPainted(page);
  const win = await openNotebook(page);
  const glyph = win.locator('canvas.app-glyph');
  await expect(glyph).toHaveCount(1);
  await expect(glyph).toHaveAttribute('aria-hidden', 'true');
  expect(await win.locator('svg.app-glyph').count()).toBe(0);
  const light = await look(glyph);
  expect(light).toMatchObject({ w: 18, h: 18, cssW: 18 });
  expect(light.inked, 'the glyph is drawn').toBeGreaterThan(0.25);

  // The theme: the same canvas, drawn again in Dark's tokens.
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect.poll(async () => (await look(glyph)).digest).not.toBe(light.digest);
  const dark = await look(glyph);
  expect(dark).toMatchObject({ w: 18, h: 18, cssW: 18 });

  // The density: a 2x screen, as a window moved to one would be, draws at 36 device pixels in the same 18 CSS pixels.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  expect(await page.evaluate(() => devicePixelRatio)).toBe(2);
  await page.evaluate(() => (window as unknown as { __screenMoved: () => void }).__screenMoved());
  await expect.poll(async () => (await look(glyph)).w).toBe(36);
  const sharp = await look(glyph);
  expect(sharp).toMatchObject({ h: 36, cssW: 18 });
  expect(sharp.inked).toBeGreaterThan(0.25);
  // 1.25x and 1.5x: 18 CSS px is 22.5 and 27 device px. The backing store is the element's own device-pixel box, each axis,
  // its edges snapped where it sits (the browser's rule), never a rounded 18 x ratio that the browser would resample to fit.
  // (Chromium's density emulation doesn't move `device-pixel-content-box`, so the box is worked out here from the element.)
  const snapped = (): Promise<{ w: number; h: number; bw: number; bh: number }> =>
    glyph.evaluate((el) => {
      const c = el as HTMLCanvasElement;
      const r = c.getBoundingClientRect();
      const span = (at: number, len: number): number => Math.round((at + len) * devicePixelRatio) - Math.round(at * devicePixelRatio);
      return { w: c.width, h: c.height, bw: span(r.left, r.width), bh: span(r.top, r.height) };
    });
  for (const ratio of [1.25, 1.5]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: ratio, mobile: false });
    expect(await page.evaluate(() => devicePixelRatio)).toBe(ratio);
    await page.evaluate(() => (window as unknown as { __screenMoved: () => void }).__screenMoved());
    await expect
      .poll(async () => {
        const b = await snapped();
        return { ...b, same: b.w === b.bw && b.h === b.bh, near: Math.abs(b.w - 18 * ratio) < 1 && Math.abs(b.h - 18 * ratio) < 1 };
      })
      .toMatchObject({ same: true, near: true });
    const at = await look(glyph);
    expect(at.cssW).toBe(18);
    expect(at.inked).toBeGreaterThan(0.25);
  }
  // And back to 1x.
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
  await page.evaluate(() => (window as unknown as { __screenMoved: () => void }).__screenMoved());
  await expect.poll(async () => (await look(glyph)).w).toBe(18);
  expect((await look(glyph)).digest).toBe(dark.digest);
  expect(errors).toEqual([]);
});
