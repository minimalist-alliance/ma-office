// Desk styles (the owner's desk textures): the chooser in a desk's menu, the texture under a desk's contents in all
// three themes, a reload and another browser keeping the choice, and what a texture costs a zoom. The registry holds
// the Designer's four and Plain, so most of these leave Plain alone and bring a style of their own: a texture made
// here, as a PNG in a data URL, given to the app before it loads (`__maTestDeskStyles`, never in a production build).
import { deflateSync } from 'node:zlib';
import { expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { canvasPainted, harness, setTheme, signIn, themeRadio, watchConsole, type ThemeId } from './helpers';

const A = 'd-personal00001';
const B = 'd-work000000001';
const ME = 'u-test';
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const LABEL: Record<ThemeId, string> = { light: 'Light', dusk: 'Zen', dark: 'Dark' };

// ----- a test texture: a 256-pixel tile of grain that repeats seamlessly, since every term is periodic in 256.

let crcTable: number[] | null = null;
function crc32(buf: Buffer): number {
  crcTable ??= Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(size: number, pixel: (x: number, y: number) => [number, number, number]): string {
  const rows = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y += 1) {
    rows[y * (size * 3 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const [r, g, b] = pixel(x, y);
      const at = y * (size * 3 + 1) + 1 + x * 3;
      rows[at] = r;
      rows[at + 1] = g;
      rows[at + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const file = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  return `data:image/png;base64,${file.toString('base64')}`;
}

const TILE = 256;
const TAU = Math.PI * 2;
const hash = (x: number, y: number): number => {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};
/** About -1 to 1: long streaks across, a finer grain, and a little noise. */
function grain(x: number, y: number): number {
  const u = x / TILE;
  const v = y / TILE;
  const warp = 0.25 * Math.sin(TAU * (2 * u + v)) + 0.12 * Math.sin(TAU * (5 * u - 2 * v));
  return 0.5 * Math.sin(TAU * (6 * v + warp)) + 0.25 * Math.sin(TAU * (32 * v + 2 * Math.sin(TAU * 3 * u))) + 0.35 * (hash(x, y) - 0.5);
}

type Rgb = [number, number, number];
const hex = ([r, g, b]: Rgb): string => `#${[r, g, b].map((c) => c.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
const shade = ([r, g, b]: Rgb, k: number): Rgb => [r, g, b].map((c) => Math.max(0, Math.min(255, Math.round(c + k)))) as Rgb;

// A pale wood in Light, a medium one in Dusk and a dark one in Dark, each with an etch that's close to it, as the owner
// asked: "dark text for dark mode, light text for light, and medium for dusk. Its supposed to blend into the desk."
const WOOD: Record<ThemeId, { base: Rgb; amp: number; fill: Rgb; wall: Rgb; highlight: string }> = {
  light: { base: [226, 214, 194], amp: 14, fill: [196, 182, 160], wall: [150, 136, 114], highlight: '#F6EFE4' },
  dusk: { base: [112, 100, 88], amp: 12, fill: [140, 128, 114], wall: [66, 58, 50], highlight: 'rgba(250, 240, 228, 0.22)' },
  dark: { base: [50, 44, 39], amp: 9, fill: [34, 30, 26], wall: [14, 12, 10], highlight: 'rgba(255, 240, 225, 0.12)' },
};

function testStyles(asDefault = false): unknown[] {
  const looks = Object.fromEntries(THEMES.map((theme) => {
    const w = WOOD[theme];
    return [theme, {
      base: hex(w.base),
      etch: { fill: hex(w.fill), wall: hex(w.wall), highlight: w.highlight },
      texture: { src: png(TILE, (x, y) => shade(w.base, w.amp * grain(x, y))), width: TILE, height: TILE, density: 2 },
    }];
  }));
  return [{ id: 'grain', name: 'Grain', onlyPlain: true, ...(asDefault ? { default: true } : {}), looks }];
}

async function withTestStyle(page: Page, asDefault = false): Promise<void> {
  await page.addInitScript((styles) => {
    (window as unknown as { __maTestDeskStyles: unknown }).__maTestDeskStyles = styles;
  }, testStyles(asDefault));
}

// ----- the office

const desk = (deskId: string, name: string, kind: string) => ({ deskId, name, kind, state: 'running' });
const FLEET = [desk(A, 'Personal', 'personal'), desk(B, 'Work', 'work')];

type Hook = {
  __maDesk: {
    camera: { cam: { x: number; y: number; s: number }; vp: { w: number; h: number }; isMoving(): boolean; dpr(): number; animateTo(c: { s: number; x: number; y: number }, ms: number): void; getStage(): KStage };
    panelRasters(): number;
    textureLoads(): number;
  };
};
type KNode = { getAttr(k: string): unknown; findOne(q: string): KNode };
type KStage = { findOne(q: string): KNode; getLayers(): { getCanvas(): { getContext(): { _context: CanvasRenderingContext2D } } }[] };

async function open(page: Page, request: APIRequestContext, theme: ThemeId = 'light', shipped = false): Promise<string[]> {
  const errors = watchConsole(page);
  // The styles as they ship: an empty list of test styles, so `signIn` doesn't leave only Plain.
  if (shipped) await page.addInitScript(() => { (window as unknown as { __maTestDeskStyles: unknown }).__maTestDeskStyles = []; });
  await setTheme(page, theme);
  await harness(request, { fleet: FLEET });
  await signIn(page);
  await canvasPainted(page);
  await page.waitForTimeout(500);
  return errors;
}

const proxy = (page: Page, id: string): Locator => page.locator(`[id="proxy-${id}"]`);
const deskMenu = (page: Page): Locator => page.getByRole('menu', { name: 'Desk' });
const styleGroup = (page: Page): Locator => deskMenu(page).getByRole('group', { name: 'Desk style' });
const swatch = (page: Page, name: string): Locator => styleGroup(page).getByRole('menuitemradio', { name, exact: true });

/** Which look a desk's panel drew last: `<style>.<theme>`. */
const drawnLook = (page: Page, id: string): Promise<string> => page.evaluate((deskId) => String((window as unknown as Hook).__maDesk.camera.getStage().findOne(`#desk-${deskId}`).findOne('.desk-panel').getAttr('drawnLook')), id);

/** The pixels of a box in a desk's open middle (CSS pixels, inset from its proxy), as a mean and how much they vary. */
const middleOf = (page: Page, id: string): Promise<{ mean: Rgb; spread: number; edge: number }> => page.evaluate((deskId) => {
  const { camera } = (window as unknown as Hook).__maDesk;
  const el = document.getElementById(`proxy-${deskId}`)!.getBoundingClientRect();
  const stageBox = document.querySelector('.konvajs-content')!.getBoundingClientRect();
  const d = camera.dpr();
  // The band under the apps' row and over the strip: nothing but the surface.
  const x = Math.round((el.left - stageBox.left + el.width * 0.25) * d);
  const y = Math.round((el.top - stageBox.top + el.height * 0.62) * d);
  const w = Math.round(el.width * 0.5 * d);
  const h = Math.round(Math.min(40, el.height * 0.12) * d);
  const ctx = camera.getStage().getLayers()[0]!.getCanvas().getContext()._context;
  const { data } = ctx.getImageData(x, y, w, h);
  const n = data.length / 4;
  const sum = [0, 0, 0];
  for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c += 1) sum[c]! += data[i + c]!;
  const mean = sum.map((s) => Math.round(s / n)) as Rgb;
  let dev = 0;
  let edge = 0;
  for (let i = 0; i < data.length; i += 4) {
    dev += Math.abs(data[i]! - mean[0]) + Math.abs(data[i + 1]! - mean[1]) + Math.abs(data[i + 2]! - mean[2]);
    // Neighbours across a row: how fine the detail is, which a blurry texture loses.
    if ((i / 4) % w < w - 1) edge += Math.abs(data[i]! - data[i + 4]!);
  }
  return { mean, spread: dev / n, edge: edge / (n - h) };
}, id);

async function openDeskMenu(page: Page, id: string): Promise<void> {
  await proxy(page, id).focus();
  await page.keyboard.press('.');
  await expect(deskMenu(page)).toBeVisible();
}

const near = (a: Rgb, b: Rgb, tol: number): boolean => a.every((c, i) => Math.abs(c - b[i]!) <= tol);

test.beforeEach(async ({ request }) => {
  await harness(request, { reset: true });
});

test.describe('the Desk style chooser', () => {
  test('the shipped styles: Light oak is the default, then White ash, Walnut, Linoleum and Plain; the label shows the chosen name, and Saved takes its place for 1.5 s', async ({ page, request }) => {
    const errors = await open(page, request, 'light', true);
    expect(await drawnLook(page, A)).toBe('oak.light');
    await openDeskMenu(page, A);
    await expect(styleGroup(page)).toBeVisible();
    const names = await styleGroup(page).getByRole('menuitemradio').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
    expect(names).toEqual(['Light oak', 'White ash', 'Walnut', 'Linoleum', 'Plain']);
    await expect(swatch(page, 'Light oak')).toHaveAttribute('aria-checked', 'true');
    const name = deskMenu(page).getByTestId('desk-style-name');
    const status = deskMenu(page).getByTestId('desk-style-status');
    await expect(name).toHaveText('Light oak');
    await swatch(page, 'Walnut').click();
    await expect(status).toHaveText('Saved');
    await expect(name).toHaveCount(0);
    await expect.poll(() => drawnLook(page, A)).toBe('walnut.light');
    await expect(status).toHaveText('', { timeout: 2_500 });
    await expect(name).toHaveText('Walnut');
    expect(await drawnLook(page, B)).toBe('oak.light');
    // Plain is the flat desk of before, and a stored 'plain' stays valid.
    await swatch(page, 'Plain').click();
    await expect.poll(() => drawnLook(page, A)).toBe('plain.light');
    await expect.poll(async () => (await middleOf(page, A)).spread).toBeLessThan(1);
    expect(errors).toEqual([]);
  });

  test('a swatch per style, the default checked; choosing one redraws the desk behind the menu and says Saved', async ({ page, request }) => {
    await withTestStyle(page);
    const errors = await open(page, request);
    const flat = await middleOf(page, A);
    await openDeskMenu(page, A);
    await expect(styleGroup(page)).toBeVisible();
    await expect(swatch(page, 'Plain')).toHaveAttribute('aria-checked', 'true');
    await expect(swatch(page, 'Grain')).toHaveAttribute('aria-checked', 'false');
    await expect(swatch(page, 'Grain')).toHaveAttribute('title', 'Grain');
    const status = deskMenu(page).getByTestId('desk-style-status');
    await expect(status).toHaveText('');
    await expect(status).toHaveAttribute('role', 'status');

    await swatch(page, 'Grain').click();
    await expect(swatch(page, 'Grain')).toHaveAttribute('aria-checked', 'true');
    await expect(swatch(page, 'Plain')).toHaveAttribute('aria-checked', 'false');
    await expect(status).toHaveText('Saved');
    await expect(deskMenu(page)).toBeVisible(); // to try another
    await expect.poll(() => drawnLook(page, A)).toBe('grain.light');
    // The texture's on the desk, around its base, and the other desk is as it was.
    await expect.poll(async () => (await middleOf(page, A)).spread, { timeout: 4_000 }).toBeGreaterThan(4);
    const grained = await middleOf(page, A);
    expect(near(grained.mean, WOOD.light.base, 10), `${grained.mean}`).toBe(true);
    expect(near(grained.mean, flat.mean, 6)).toBe(false);
    expect(await drawnLook(page, B)).toBe('plain.light');
    // Quiet: gone after 2 s.
    await expect(status).toHaveText('', { timeout: 3_000 });

    // Picking the one it wears says nothing and saves nothing.
    await swatch(page, 'Grain').click();
    await page.waitForTimeout(300);
    await expect(status).toHaveText('');
    expect(errors).toEqual([]);
  });

  test('by keyboard: the row is one stop, Left and Right move along it, Enter chooses, Esc leaves', async ({ page, request }) => {
    await withTestStyle(page);
    await open(page, request);
    await openDeskMenu(page, A);
    const items = ['Clean up', 'Move', 'Resize', 'Rename'];
    // From the keyboard the menu opens on its first item that can be used; Down goes on to the checked swatch.
    for (let i = 0; i < 6; i += 1) {
      const name = await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent ?? '');
      if (name === 'Plain') break;
      expect(items).toContain(name);
      await page.keyboard.press('ArrowDown');
    }
    await expect(swatch(page, 'Plain')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(swatch(page, 'Grain')).toBeFocused();
    await expect(swatch(page, 'Grain')).toHaveAttribute('aria-checked', 'false'); // moving isn't choosing
    await page.keyboard.press('ArrowRight'); // the end of the row stays put
    await expect(swatch(page, 'Grain')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(swatch(page, 'Plain')).toBeFocused();
    await page.keyboard.press('End');
    await expect(swatch(page, 'Grain')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(swatch(page, 'Grain')).toHaveAttribute('aria-checked', 'true');
    await expect(deskMenu(page).getByTestId('desk-style-status')).toHaveText('Saved');
    await expect(swatch(page, 'Grain')).toBeFocused();
    // Down from the row wraps to the menu's first item, and Up comes back to the swatch last focused.
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('.desk-menu [role="menuitem"]:focus')).toHaveCount(1);
    await page.keyboard.press('ArrowUp');
    await expect(swatch(page, 'Grain')).toBeFocused();
    await page.keyboard.press('Space');
    await page.keyboard.press('Escape');
    await expect(deskMenu(page)).toHaveCount(0);
    await expect(proxy(page, A)).toBeFocused();
    await expect.poll(() => drawnLook(page, A)).toBe('grain.light');
  });

  test('an app\'s menu has no Desk style', async ({ page, request }) => {
    await withTestStyle(page);
    await open(page, request);
    await page.locator(`[id="proxy-${A}:notebook"]`).focus();
    await page.keyboard.press('.');
    await expect(page.getByRole('menu', { name: 'App' })).toBeVisible();
    await expect(page.getByRole('menu', { name: 'App' }).getByRole('group', { name: 'Desk style' })).toHaveCount(0);
  });
});

test.describe('a style on the canvas', () => {
  test('the etch takes the style\'s colors, the texture its theme\'s, and a theme switch draws both in the same frame', async ({ page, request }) => {
    await withTestStyle(page);
    await open(page, request);
    await openDeskMenu(page, A);
    await swatch(page, 'Grain').click();
    await page.keyboard.press('Escape');
    await expect.poll(async () => (await middleOf(page, A)).spread, { timeout: 4_000 }).toBeGreaterThan(4);
    // The other themes' textures load at idle, so a switch has them.
    await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.textureLoads()), { timeout: 4_000 }).toBe(3);

    for (const theme of ['dark', 'dusk', 'light'] as ThemeId[]) {
      // Every frame from the click on: the look the desk drew, and how much a strip of its open middle varies.
      await page.evaluate((target) => {
        const w = window as unknown as Hook & { __looks: { look: string; spread: number }[] };
        w.__looks = [];
        const { camera } = w.__maDesk;
        const stage = camera.getStage();
        const el = document.getElementById('proxy-d-personal00001')!.getBoundingClientRect();
        const box = document.querySelector('.konvajs-content')!.getBoundingClientRect();
        const d = camera.dpr();
        const x = Math.round((el.left - box.left + el.width * 0.3) * d);
        const y = Math.round((el.top - box.top + el.height * 0.62) * d);
        const ctx = stage.getLayers()[0]!.getCanvas().getContext()._context;
        const loop = (): void => {
          const look = String(stage.findOne('#desk-d-personal00001').findOne('.desk-panel').getAttr('drawnLook'));
          const { data } = ctx.getImageData(x, y, Math.round(80 * d), Math.round(12 * d));
          let lo = 255;
          let hi = 0;
          for (let i = 0; i < data.length; i += 4) {
            lo = Math.min(lo, data[i]!);
            hi = Math.max(hi, data[i]!);
          }
          w.__looks.push({ look, spread: hi - lo });
          // Until a second of frames in the new theme, or 20 s.
          if (w.__looks.filter((f) => f.look === target).length < 60 && w.__looks.length < 1200) requestAnimationFrame(loop);
        };
        requestAnimationFrame(loop);
      }, `grain.${theme}`);
      await page.getByRole('button', { name: 'Account' }).click();
      await themeRadio(page, LABEL[theme]).click();
      await page.keyboard.press('Escape');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      await expect.poll(() => drawnLook(page, A)).toBe(`grain.${theme}`);
      // The first frame it's drawn in this theme already has the texture: nothing was waiting on a fetch.
      const mid = await middleOf(page, A);
      expect(mid.spread, theme).toBeGreaterThan(3);
      expect(near(mid.mean, WOOD[theme].base, 10), `${theme} ${mid.mean}`).toBe(true);
      // Every frame drawn in the new theme already had the texture: nothing waited on a fetch or a decode.
      await expect.poll(() => page.evaluate((target) => (window as unknown as { __looks: { look: string }[] }).__looks.filter((f) => f.look === target).length, `grain.${theme}`)).toBe(60);
      const frames = await page.evaluate(() => (window as unknown as { __looks: { look: string; spread: number }[] }).__looks);
      const inTheme = frames.filter((f) => f.look === `grain.${theme}`);
      expect(inTheme.length, theme).toBeGreaterThan(0);
      expect(inTheme.filter((f) => f.spread < 6), `${theme}: frames with a flat middle`).toEqual([]);
      expect(await drawnLook(page, B), theme).toBe(`plain.${theme}`);
    }
    expect(await page.evaluate(() => (window as unknown as Hook).__maDesk.textureLoads())).toBe(3);
  });

  test('the etched name is cut in the style\'s colors: the same name reads differently on each desk', async ({ page, request }) => {
    await withTestStyle(page);
    await open(page, request);
    const ink = (id: string): Promise<{ darkest: number; lightest: number }> => page.evaluate((deskId) => {
      const { camera } = (window as unknown as Hook).__maDesk;
      const el = document.getElementById(`proxy-${deskId}`)!.getBoundingClientRect();
      const stageBox = document.querySelector('.konvajs-content')!.getBoundingClientRect();
      const d = camera.dpr();
      const cx = el.left - stageBox.left + el.width / 2;
      const ctx = camera.getStage().getLayers()[0]!.getCanvas().getContext()._context;
      const { data } = ctx.getImageData(Math.round((cx - 60) * d), Math.round((el.bottom - stageBox.top - 34) * d), Math.round(120 * d), Math.round(24 * d));
      let darkest = 255;
      let lightest = 0;
      for (let i = 0; i < data.length; i += 4) {
        darkest = Math.min(darkest, data[i]!);
        lightest = Math.max(lightest, data[i]!);
      }
      return { darkest, lightest };
    }, id);
    const before = await ink(A);
    await openDeskMenu(page, A);
    await swatch(page, 'Grain').click();
    await page.keyboard.press('Escape');
    await expect.poll(() => drawnLook(page, A)).toBe('grain.light');
    await page.waitForTimeout(200);
    const after = await ink(A);
    // Light's plain wall is #3A3F47 (58); Grain's is a light brown (150), so the darkest pixel of the cut rises.
    expect(before.darkest).toBeLessThan(80);
    expect(after.darkest).toBeGreaterThan(100);
  });

  test('a corner drag keeps the texture where it was, at most one bitmap for the whole drag, and an exact one at the drop', async ({ page, request }) => {
    await withTestStyle(page, true);
    await open(page, request);
    await expect.poll(async () => (await middleOf(page, A)).spread, { timeout: 4_000 }).toBeGreaterThan(4);
    const rasters = (): Promise<number> => page.evaluate(() => (window as unknown as Hook).__maDesk.panelRasters());
    const b = (await proxy(page, A).boundingBox())!;
    const from = { x: b.x + b.width - 12, y: b.y + b.height - 12 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 10, from.y + 10, { steps: 2 });
    const start = await rasters();
    const seen: number[] = [];
    for (let i = 1; i <= 12; i += 1) {
      await page.mouse.move(from.x + 10 + i * 9, from.y + 10 + i * 6);
      await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
      seen.push((await middleOf(page, A)).spread);
    }
    expect(await rasters(), 'bitmaps during the drag').toBeLessThanOrEqual(start + 1);
    // The texture shows on every frame of it, drawn from its pattern in the desk's own units.
    expect(seen.every((v) => v > 4), `${seen.map((v) => v.toFixed(1))}`).toBe(true);
    await page.mouse.up();
    await page.waitForTimeout(300);
    expect((await middleOf(page, A)).spread).toBeGreaterThan(4);
    expect(await drawnLook(page, A)).toBe('grain.light');
  });

  test('under more contrast a desk is today\'s flat surface, whatever its style, and back when that\'s off', async ({ page, request }) => {
    await withTestStyle(page, true);
    await open(page, request);
    await expect.poll(async () => (await middleOf(page, A)).spread, { timeout: 4_000 }).toBeGreaterThan(4);
    await page.emulateMedia({ contrast: 'more' });
    await expect.poll(() => drawnLook(page, A)).toBe('flat.light');
    expect((await middleOf(page, A)).spread).toBeLessThan(1);
    await page.emulateMedia({ contrast: 'no-preference' });
    await expect.poll(() => drawnLook(page, A)).toBe('grain.light');
    await expect.poll(async () => (await middleOf(page, A)).spread).toBeGreaterThan(4);
  });

  test('crisp at a device pixel ratio of 2: at rest the texture keeps its fine detail', async ({ browser, request }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, baseURL: test.info().project.use.baseURL });
    const page = await context.newPage();
    await withTestStyle(page, true);
    await open(page, request);
    // 100 %: two device pixels to a unit, which is the test texture's own density, so the copy drawn is the image itself.
    await page.evaluate(() => {
      const { camera } = (window as unknown as Hook).__maDesk;
      camera.animateTo({ s: 1, x: 40.37, y: 60.19 }, 0);
    });
    await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving())).toBe(false);
    await expect.poll(async () => (await middleOf(page, A)).spread, { timeout: 4_000 }).toBeGreaterThan(4);
    const drawn = await middleOf(page, A);
    // The tile's own detail across a row, from the same function.
    const w = WOOD.light;
    let own = 0;
    let n = 0;
    for (let y = 0; y < TILE; y += 7) {
      for (let x = 0; x < TILE - 1; x += 1) {
        own += Math.abs(shade(w.base, w.amp * grain(x, y))[0] - shade(w.base, w.amp * grain(x + 1, y))[0]);
        n += 1;
      }
    }
    own /= n;
    // A raster at 1x scaled up would have about half of it.
    expect(drawn.edge, `drawn ${drawn.edge.toFixed(2)}, tile ${own.toFixed(2)}`).toBeGreaterThan(own * 0.8);
    await context.close();
  });
});

test.describe('the choice is kept', () => {
  test('on Platform, through a reload and in another browser', async ({ page, request, browser }) => {
    await withTestStyle(page);
    await open(page, request);
    await openDeskMenu(page, A);
    await swatch(page, 'Grain').click();
    await page.keyboard.press('Escape');
    // One save, with the style on that desk only.
    const saved = async (): Promise<{ desks: Record<string, { style?: string }> } | null> => ((await (await request.get('/__harness')).json()) as { layoutDocs: Record<string, { layout: { desks: Record<string, { style?: string }> } | null } | undefined> }).layoutDocs[ME]?.layout ?? null;
    await expect.poll(async () => (await saved())?.desks[A]?.style, { timeout: 8_000 }).toBe('grain');
    expect((await saved())!.desks[B]!.style).toBeUndefined();
    const mirror = await page.evaluate(() => JSON.parse(localStorage.getItem('ma.layout.v2') ?? 'null') as { desks: Record<string, { style?: string }> });
    expect(mirror.desks[A]!.style).toBe('grain');

    await page.reload();
    await canvasPainted(page);
    await expect.poll(() => drawnLook(page, A)).toBe('grain.light');
    await openDeskMenu(page, A);
    await expect(swatch(page, 'Grain')).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');

    // Another browser, with nothing of its own: Platform's copy brings it.
    const other = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: test.info().project.use.baseURL });
    const second = await other.newPage();
    await withTestStyle(second);
    await signIn(second);
    await canvasPainted(second);
    await expect.poll(() => drawnLook(second, A), { timeout: 6_000 }).toBe('grain.light');
    expect(await drawnLook(second, B)).toBe('plain.light');
    await other.close();
  });

  test('a style this build doesn\'t know draws as the default, and goes back to Platform as it came', async ({ page, request }) => {
    await harness(request, {
      layoutDocs: {
        [ME]: {
          version: 3,
          updatedAt: '2026-11-08T00:00:00Z',
          layout: {
            schemaVersion: 2,
            desks: {
              [A]: { x: 0, y: 0, w: 584, h: 236, items: [], style: 'walnut-from-a-newer-build' },
              [B]: { x: 700, y: 0, w: 584, h: 236, items: [] },
            },
            z: [A, B],
          },
        },
      },
    });
    const errors = await open(page, request);
    expect(await drawnLook(page, A)).toBe('plain.light');
    // A change to the other desk saves the whole document: the unknown style is still there.
    await proxy(page, B).focus();
    await page.keyboard.press('m');
    await page.keyboard.press('Shift+ArrowDown');
    await page.keyboard.press('Enter');
    const saved = async (): Promise<number> => ((await (await request.get('/__harness')).json()) as { layoutDocs: Record<string, { version: number }> }).layoutDocs[ME]!.version;
    await expect.poll(saved, { timeout: 8_000 }).toBe(4);
    const doc = ((await (await request.get('/__harness')).json()) as { layoutDocs: Record<string, { layout: { desks: Record<string, { style?: string }> } }> }).layoutDocs[ME]!.layout;
    expect(doc.desks[A]!.style).toBe('walnut-from-a-newer-build');
    expect(errors).toEqual([]);
  });
});

test.describe('what a texture costs', () => {
  /** rAF intervals and panel bitmaps through a zoom out and back in, by wheel, as a member does. */
  async function zoomRun(page: Page): Promise<{ frames: number[]; rastersInMotion: number[] }> {
    await page.mouse.move(720, 450);
    await page.evaluate(() => {
      const w = window as unknown as Hook & { __run: { t: number; moving: boolean; rasters: number }[] };
      w.__run = [];
      const loop = (t: number): void => {
        w.__run.push({ t, moving: w.__maDesk.camera.isMoving(), rasters: w.__maDesk.panelRasters() });
        if (w.__run.length < 400) requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);
    });
    for (let i = 0; i < 24; i += 1) {
      await page.mouse.wheel(0, 50);
      await page.waitForTimeout(16);
    }
    for (let i = 0; i < 24; i += 1) {
      await page.mouse.wheel(0, -50);
      await page.waitForTimeout(16);
    }
    await page.waitForTimeout(600);
    const run = await page.evaluate(() => (window as unknown as { __run: { t: number; moving: boolean; rasters: number }[] }).__run);
    const frames: number[] = [];
    const rastersInMotion: number[] = [];
    // Unbroken runs of frames in motion, each with the bitmaps made inside it. The first frame of a run is the settle's own raster before it.
    let runStart = -1;
    run.forEach((f, i) => {
      const prev = run[i - 1];
      if (!f.moving) {
        if (runStart >= 0) rastersInMotion.push(run[i - 1]!.rasters - run[runStart]!.rasters);
        runStart = -1;
        return;
      }
      if (runStart < 0) runStart = i;
      else if (prev) frames.push(f.t - prev.t);
    });
    return { frames, rastersInMotion };
  }

  const median = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
  const p95 = (a: number[]): number => [...a].sort((x, y) => x - y)[Math.floor(a.length * 0.95)] ?? 0;

  test('a zoom over 24 textured desks makes no bitmap while it moves, and its frames keep pace with plain desks', async ({ browser }) => {
    const results: Record<'plain' | 'grain', number[]> = { plain: [], grain: [] };
    // Alternate, twice each: this machine is shared, and one run against another mostly measures who else was busy.
    for (const kind of ['plain', 'grain', 'plain', 'grain'] as const) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, baseURL: test.info().project.use.baseURL });
      const page = await context.newPage();
      if (kind === 'grain') await withTestStyle(page, true);
      await signIn(page, '/?fixture=perf');
      await canvasPainted(page);
      await page.waitForTimeout(800);
      if (kind === 'grain') {
        await expect.poll(() => drawnLook(page, 'd-fix00')).toMatch(/^grain\./);
        await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.textureLoads()), { timeout: 6_000 }).toBe(3);
        await page.waitForTimeout(800); // decoded, and drawn into every panel
      }
      const run = await zoomRun(page);
      expect(run.frames.length, kind).toBeGreaterThan(20);
      // While the camera moves, nothing is rastered: the texture is in the panels' bitmaps already.
      expect(run.rastersInMotion.every((n) => n === 0), `${kind}: ${run.rastersInMotion}`).toBe(true);
      results[kind].push(...run.frames);
      await context.close();
    }
    const plain = { median: median(results.plain), p95: p95(results.plain) };
    const grain = { median: median(results.grain), p95: p95(results.grain) };
    test.info().annotations.push({ type: 'frames', description: `plain median ${plain.median.toFixed(1)} p95 ${plain.p95.toFixed(1)} ms; grain median ${grain.median.toFixed(1)} p95 ${grain.p95.toFixed(1)} ms` });
    console.log(`frame ms: plain median ${plain.median.toFixed(1)} p95 ${plain.p95.toFixed(1)}; grain median ${grain.median.toFixed(1)} p95 ${grain.p95.toFixed(1)}`);
    expect(grain.median, 'median frame').toBeLessThanOrEqual(Math.max(plain.median * 1.25, plain.median + 3));
    expect(grain.p95, 'p95 frame').toBeLessThanOrEqual(Math.max(plain.p95 * 1.5, plain.p95 + 8));
  });
});

test.describe('shots', () => {
  for (const theme of THEMES) {
    test(`the office with a textured desk and its menu, in ${theme}`, async ({ page, request }) => {
      await withTestStyle(page);
      await open(page, request, theme);
      await openDeskMenu(page, A);
      await swatch(page, 'Grain').click();
      await expect.poll(async () => (await middleOf(page, A)).spread, { timeout: 4_000 }).toBeGreaterThan(3);
      await page.screenshot({ path: `test-results/shots/desk-style-${theme}-menu.png` });
      await page.keyboard.press('Escape');
      await page.mouse.move(5, 895);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `test-results/shots/desk-style-${theme}.png` });
      // Close up, at 175 %, where a member works on one desk.
      await page.evaluate(() => {
        const { camera } = (window as unknown as Hook).__maDesk;
        const el = document.getElementById('proxy-d-personal00001')!.getBoundingClientRect();
        const s = 1.75;
        const wx = (el.left + el.width / 2 - camera.cam.x) / camera.cam.s;
        const wy = (el.top + el.height / 2 - camera.cam.y) / camera.cam.s;
        camera.animateTo({ s, x: camera.vp.w / 2 - wx * s, y: camera.vp.h / 2 - wy * s }, 0);
      });
      await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving())).toBe(false);
      await page.waitForTimeout(300);
      await page.screenshot({ path: `test-results/shots/desk-style-${theme}-175.png` });
    });
  }
});

test.describe('the shipped styles on the desk', () => {
  for (const theme of THEMES) {
    test(`${LABEL[theme]}: one desk in each style draws and its image arrives`, async ({ page, request }) => {
      const errors = await open(page, request, theme, true);
      for (const [id, label] of [['oak', 'Light oak'], ['ash', 'White ash'], ['walnut', 'Walnut'], ['linoleum', 'Linoleum'], ['plain', 'Plain']] as const) {
        await openDeskMenu(page, A);
        await swatch(page, label).click();
        await page.keyboard.press('Escape');
        await expect.poll(() => drawnLook(page, A)).toBe(`${id}.${theme}`);
        if (id !== 'plain') await expect.poll(async () => (await middleOf(page, A)).spread, { timeout: 6_000 }).toBeGreaterThan(1);
        await page.waitForTimeout(300);
        await page.screenshot({ path: `test-results/shots/shipped-style-${id}-${theme}.png` });
      }
      expect(errors).toEqual([]);
    });
  }
});
