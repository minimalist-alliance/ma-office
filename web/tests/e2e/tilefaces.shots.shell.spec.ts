// Shots of every app's tile at each size (icon, medium, large, open and not live, open and live) at office zooms 25, 50, 75,
// 100 and 175 %, in Light, Zen and Dark, with the mock desk's widget words and without them (`?widgets=none`), for the
// Designer: a tile never draws a card with nothing readable on it (`tileFace`, canvas/layout.ts). Plus each size's desk whole
// at each zoom, a 390 px phone, and "Open in its window" under the glyph. On MockDeskLink: nobody's real data. Skipped unless
// TILE_ICON_SHOTS names the folder to write to, so it never runs in the suite:
//   TILE_ICON_SHOTS=/abs/dir MA_PW_PORT=5101 npx playwright test --project=shell tilefaces.shots --workers=1
// The contact sheets come from `contact-sheets.py`, kept beside the shots (docs/sub-status/tile-icon-fallback.md says where).
import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const OUT = process.env['TILE_ICON_SHOTS'] ?? '';
const THEMES: ThemeId[] = ['light', 'dusk', 'dark'];
const NAMES: Record<ThemeId, string> = { light: 'light', dusk: 'zen', dark: 'dark' };
const BIBLE = 'com.minimalistalliance.bible';
const ZOOMS = [0.25, 0.5, 0.75, 1, 1.75];
/** `TILE_ICON_SIZES=large,open` retakes those rows alone (`live` for the live row); unset, every size, the phone and the note. */
const ONLY = process.env['TILE_ICON_SIZES']?.split(',') ?? null;
const wanted = (size: string): boolean => !ONLY || ONLY.includes(size);

test.skip(!OUT, 'TILE_ICON_SHOTS names the folder for the screenshots');
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
test.setTimeout(900_000);

const span = (cells: number): number => cells * 76 + (cells - 1) * 16;
const SIZES = {
  icon: { w: 76, h: 76 },
  medium: { w: span(2), h: span(2) },
  large: { w: span(4), h: span(4) },
  open: { w: span(6), h: span(5) },
} as const;
type SizeName = keyof typeof SIZES;
const BROWSER_OPEN = { w: span(7), h: span(5) };
/** The apps, by the name a shot carries. */
const APPS: [string, string][] = [['browser', 'browser'], ['notebook', 'notebook'], ['agent', 'agent'], ['files', 'files'], ['courier', 'courier'], ['bible', `app:${BIBLE}`]];
const DESK_IDS: Record<SizeName, string> = { icon: 'd-personal00001', medium: 'd-work000000001', large: 'd-studio0000001', open: 'd-fourth0000001' };
const DESK_NAMES: Record<SizeName, string> = { icon: 'Icons', medium: 'Medium', large: 'Large', open: 'Open' };
const DESK_Y: Record<SizeName, number> = { icon: 0, medium: 300, large: 700, open: 1650 };

interface Item { id: string; app: string; x: number; y: number; w: number; h: number }
interface Desk { x: number; y: number; w: number; h: number; items: Item[] }
type Hook = { __maDesk: { camera: { cam: { x: number; y: number; s: number }; isMoving(): boolean; set(c: { x: number; y: number; s: number }): void } } };

function deskFor(size: SizeName): Desk {
  const id = DESK_IDS[size];
  const items: Item[] = APPS.map(([, app], n) => {
    const s = size === 'open' && app === 'browser' ? BROWSER_OPEN : SIZES[size];
    if (size === 'icon' || size === 'medium') return { id: `${id}:${app}`, app, x: 24 + n * (s.w + 16), y: 24, ...s };
    const col = n % 3;
    const row = Math.floor(n / 3);
    // The open Browser, first in its row, is wider: the columns after it start later.
    const first = row === 0 && size === 'open' ? BROWSER_OPEN.w : s.w;
    const x = col === 0 ? 24 : 24 + first + 16 + (col - 1) * (SIZES[size].w + 16);
    return { id: `${id}:${app}`, app, x, y: 24 + row * (SIZES[size].h + 16), ...s };
  });
  return {
    x: 0,
    y: DESK_Y[size],
    w: Math.max(...items.map((i) => i.x + i.w)) + 24,
    h: Math.max(...items.map((i) => i.y + i.h)) + 44 + 16,
    items,
  };
}
const DESKS = Object.fromEntries((Object.keys(SIZES) as SizeName[]).map((s) => [DESK_IDS[s], deskFor(s)])) as Record<string, Desk>;

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(300);
}

async function arrive(page: Page, request: APIRequestContext, theme: ThemeId, words: boolean): Promise<string[]> {
  const errors = watchConsole(page);
  await page.addInitScript((init) => {
    (window as unknown as { __maAppsMockInit: unknown }).__maAppsMockInit = init;
  }, { available: true, installMs: 60_000, preinstalled: Object.fromEntries(Object.values(DESK_IDS).map((d) => [d, [BIBLE]])), tamper: {} });
  await setTheme(page, theme);
  await harness(request, { reset: true });
  await harness(request, {
    fleet: (Object.keys(SIZES) as SizeName[]).map((s, n) => ({ deskId: DESK_IDS[s], name: DESK_NAMES[s], kind: n === 0 ? 'personal' : 'work', state: 'running' })),
    files: { enabled: true },
    appFrames: true,
    layoutDocs: { 'u-test': { version: 1, updatedAt: '2026-11-11T00:00:00Z', layout: { schemaVersion: 2, desks: DESKS, z: Object.values(DESK_IDS) } } },
  });
  await signIn(page, words ? '/' : '/?widgets=none');
  await canvasPainted(page);
  await page.waitForTimeout(600);
  return errors;
}

/** Shows a desk, as a press on it does: the desk is the one looked at, so its open tiles may be live. */
async function showDesk(page: Page, size: SizeName): Promise<void> {
  await page.locator(`[id="proxy-${DESK_IDS[size]}"]`).evaluate((el) => (el as HTMLButtonElement).click());
  await settled(page);
}

/** The whole office in view: no desk is looked at, so no tile is live, at any zoom. */
async function overview(page: Page): Promise<void> {
  await focusCanvas(page);
  await page.keyboard.press('0');
  await settled(page);
}

/** World point (x, y) at the middle of the screen, at scale s. */
async function look(page: Page, x: number, y: number, s: number): Promise<void> {
  await page.evaluate(({ x, y, s }) => (window as unknown as Hook).__maDesk.camera.set({ s, x: window.innerWidth / 2 - x * s, y: window.innerHeight / 2 - y * s }), { x, y, s });
  await settled(page);
}

async function shot(page: Page, path: string, clip?: { x: number; y: number; width: number; height: number }): Promise<void> {
  await page.screenshot({ path, ...(clip ? { clip } : {}) });
}

/** A tile centred on screen (`look`), and 20 px of desk around it, inside the viewport. */
function clipOf(i: Item, s: number): { x: number; y: number; width: number; height: number } {
  const x = Math.max(0, Math.floor(640 - (i.w * s) / 2 - 20));
  const y = Math.max(0, Math.floor(400 - (i.h * s) / 2 - 20));
  return { x, y, width: Math.min(1280, Math.ceil(640 + (i.w * s) / 2 + 20)) - x, height: Math.min(800, Math.ceil(400 + (i.h * s) / 2 + 20)) - y };
}

for (const theme of THEMES) {
  for (const words of [false, true]) {
    const variant = words ? 'words' : 'nowords';
    test(`${NAMES[theme]}, ${variant}: every app at every size and zoom`, async ({ page, request }) => {
      const dir = `${OUT}/${NAMES[theme]}/${variant}`;
      mkdirSync(`${dir}/tiles`, { recursive: true });
      mkdirSync(`${dir}/desks`, { recursive: true });
      const errors = await arrive(page, request, theme, words);
      const index: { app: string; size: string; zoom: number; file: string; live: boolean; face: string | null }[] = [];
      const faceOf = (id: string): Promise<string | null> => page.evaluate((i) => {
        const n = (window as unknown as { __maDesk: { camera: { getStage(): { findOne(q: string): { visible(): boolean; findOne(q: string): { getAttr(k: string): unknown } } | undefined } } } }).__maDesk.camera.getStage().findOne(`#tile-${i}`);
        return n?.visible() ? String(n.findOne('Shape').getAttr('face')) : null;
      }, id);

      for (const size of (Object.keys(SIZES) as SizeName[]).filter(wanted)) {
        const d = DESKS[DESK_IDS[size]]!;
        for (const zoom of ZOOMS) {
          // Not live: on the shown desk while it's too small on screen, and from the overview at 100 and 175 %.
          if (size === 'open' && zoom >= 1) await overview(page);
          else await showDesk(page, size);
          await look(page, d.x + d.w / 2, d.y + d.h / 2, zoom);
          await page.mouse.move(2, 790);
          await shot(page, `${dir}/desks/${size}-${zoom * 100}.png`);
          for (const [name, app] of APPS) {
            const i = d.items.find((x) => x.app === app)!;
            await look(page, d.x + i.x + i.w / 2, d.y + i.y + i.h / 2, zoom);
            if (size === 'open') await expect(page.locator('.open-tile')).toHaveCount(0);
            const file = `tiles/${name}-${size}-${zoom * 100}.png`;
            await shot(page, `${dir}/${file}`, clipOf(i, zoom));
            index.push({ app: name, size, zoom, file, live: false, face: await faceOf(i.id) });
          }
        }
      }

      // Open and live: only from 480 x 320 px on screen, so at 100 and 175 %.
      const d = DESKS[DESK_IDS.open]!;
      if (wanted('live')) await showDesk(page, 'open');
      for (const zoom of wanted('live') ? [1, 1.75] : []) {
        for (const [name, app] of APPS) {
          const i = d.items.find((x) => x.app === app)!;
          await look(page, d.x + i.x + i.w / 2, d.y + i.y + i.h / 2, zoom);
          const live = page.locator(`.open-tile[data-item="${i.id}"]`);
          await expect(live).toBeVisible();
          if (name === 'browser') await expect.poll(() => live.getByTestId('browser-video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
          await page.waitForTimeout(900);
          const file = `tiles/${name}-live-${zoom * 100}.png`;
          await shot(page, `${dir}/${file}`, clipOf(i, zoom));
          index.push({ app: name, size: 'live', zoom, file, live: true, face: null });
        }
      }

      // A 390 px phone: its grid, the medium and the large desk.
      if (!ONLY) await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(600);
      for (const size of ONLY ? [] : ['medium', 'large'] as SizeName[]) {
        await showDesk(page, size);
        await page.waitForTimeout(400);
        await shot(page, `${dir}/phone-${size}.png`);
      }
      writeFileSync(`${dir}/index.json`, JSON.stringify(index, null, 1));
      expect(errors).toEqual([]);
    });
  }

  // "Open in its window" under the glyph: Files' app in its window, moved right, and its tile at 75 % on the left.
  test(`${NAMES[theme]}: "Open in its window" under the glyph`, async ({ page, request }) => {
    test.skip(!!ONLY, 'TILE_ICON_SIZES retakes rows alone');
    const errors = await arrive(page, request, theme, false);
    const d = DESKS[DESK_IDS.open]!;
    const i = d.items.find((x) => x.app === 'files')!;
    await showDesk(page, 'open');
    await look(page, d.x + i.x + i.w / 2, d.y + i.y + i.h / 2, 1);
    const files = page.getByTestId('open-tile-files');
    await expect(files).toBeVisible();
    await files.getByRole('button', { name: 'Open in its window' }).click();
    const win = page.getByRole('dialog', { name: /Files/ });
    await expect(win).toBeVisible();
    await page.waitForTimeout(800);
    const wb = (await win.boundingBox())!;
    const wh = (await win.locator('.window-head').boundingBox())!;
    const from = { x: wh.x + wh.width / 2, y: wh.y + wh.height / 2 };
    const dx = 1280 - 12 - (wb.x + wb.width);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let n = 1; n <= 8; n += 1) await page.mouse.move(from.x + (dx * n) / 8, from.y);
    await page.mouse.up();
    await page.evaluate(({ x, y }) => (window as unknown as Hook).__maDesk.camera.set({ s: 0.75, x: 16 - x * 0.75, y: 400 - y * 0.75 }), { x: d.x + i.x, y: d.y + i.y + i.h / 2 });
    await settled(page);
    await page.mouse.move(2, 790);
    await page.waitForTimeout(400);
    mkdirSync(`${OUT}/${NAMES[theme]}/nowords`, { recursive: true });
    await shot(page, `${OUT}/${NAMES[theme]}/nowords/files-open-in-its-window-75.png`);
    await shot(page, `${OUT}/${NAMES[theme]}/nowords/tiles/files-in-window-75.png`, { x: 0, y: Math.floor(400 - (i.h * 0.75) / 2 - 20), width: Math.ceil(16 + i.w * 0.75 + 20), height: Math.ceil(i.h * 0.75 + 40) });
    expect(errors).toEqual([]);
  });
}
