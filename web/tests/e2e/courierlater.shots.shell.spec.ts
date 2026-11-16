// Shots of Courier's "Coming later" chip for the Designer (courierlater.shell.spec.ts has the checks): Courier medium and large at 75 and
// 175 %, where the chip shows; at 50 %, where it hides with the words; Courier as an icon at 100 %, where it never shows; and an open
// Courier tile with its window open, the chip above "Open in its window". Light, Zen and Dark, on MockDeskLink: nobody's real data.
// Skipped unless COURIER_LATER_SHOTS names the folder to write to, so it never runs in the suite:
//   COURIER_LATER_SHOTS=/abs/dir MA_PW_PORT=5181 npx playwright test --project=shell courierlater.shots --workers=1
import { mkdirSync } from 'node:fs';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { canvasPainted, focusCanvas, harness, setTheme, signIn, watchConsole, type ThemeId } from './helpers';

const OUT = process.env['COURIER_LATER_SHOTS'] ?? '';
const NAMES: Record<ThemeId, string> = { light: 'light', dusk: 'zen', dark: 'dark' };

test.skip(!OUT, 'COURIER_LATER_SHOTS names the folder for the screenshots');
test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
test.setTimeout(180_000);

const span = (cells: number): number => cells * 76 + (cells - 1) * 16;
const ICON = { w: 76, h: 76 };
const MEDIUM = { w: span(2), h: span(2) };
const LARGE = { w: span(4), h: span(4) };
const OPEN = { w: span(6), h: span(5) };

interface Item { id: string; app: string; x: number; y: number; w: number; h: number }
interface Desk { x: number; y: number; w: number; h: number; items: Item[] }
type Hook = { __maDesk: { camera: { isMoving(): boolean; set(c: { x: number; y: number; s: number }): void } } };

const IDS = { medium: 'd-personal00001', large: 'd-studio0000001', icon: 'd-work000000001', open: 'd-fourth0000001' } as const;
const item = (deskId: string, app: string, x: number, y: number, size: { w: number; h: number }): Item => ({ id: `${deskId}:${app}`, app, x, y, ...size });
const deskOf = (x: number, y: number, items: Item[]): Desk => ({ x, y, w: Math.max(...items.map((i) => i.x + i.w)) + 24, h: Math.max(...items.map((i) => i.y + i.h)) + 44 + 16, items });
const DESKS: Record<string, Desk> = {
  [IDS.medium]: deskOf(0, 0, [item(IDS.medium, 'courier', 24, 24, MEDIUM), item(IDS.medium, 'notebook', 24 + MEDIUM.w + 16, 24, MEDIUM), item(IDS.medium, 'browser', 24 + 2 * (MEDIUM.w + 16), 24, ICON)]),
  [IDS.large]: deskOf(0, 400, [item(IDS.large, 'courier', 24, 24, LARGE), item(IDS.large, 'notebook', 24 + LARGE.w + 16, 24, MEDIUM)]),
  [IDS.icon]: deskOf(800, 0, [item(IDS.icon, 'courier', 24, 24, ICON), item(IDS.icon, 'notebook', 116, 24, ICON), item(IDS.icon, 'browser', 208, 24, ICON)]),
  [IDS.open]: deskOf(800, 400, [item(IDS.open, 'courier', 24, 24, OPEN)]),
};

async function settled(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => (window as unknown as Hook).__maDesk.camera.isMoving()), { timeout: 5_000 }).toBe(false);
  await page.waitForTimeout(400);
}

async function arrive(page: Page, request: APIRequestContext, theme: ThemeId): Promise<string[]> {
  const errors = watchConsole(page);
  await setTheme(page, theme);
  await harness(request, { reset: true });
  await harness(request, {
    fleet: [
      { deskId: IDS.medium, name: 'Personal', kind: 'personal', state: 'running' },
      { deskId: IDS.large, name: 'Studio', kind: 'work', state: 'running' },
      { deskId: IDS.icon, name: 'Work', kind: 'work', state: 'running' },
      { deskId: IDS.open, name: 'Open', kind: 'work', state: 'running' },
    ],
    layoutDocs: { 'u-test': { version: 1, updatedAt: '2026-11-12T00:00:00Z', layout: { schemaVersion: 2, desks: DESKS, z: Object.keys(DESKS) } } },
  });
  await signIn(page, '/');
  await canvasPainted(page);
  await focusCanvas(page);
  await page.keyboard.press('0');
  await settled(page);
  return errors;
}

/** A desk's middle at the middle of the screen, at scale s. */
async function look(page: Page, deskId: string, s: number): Promise<void> {
  const d = DESKS[deskId]!;
  await page.evaluate(({ s, x, y }) => (window as unknown as Hook).__maDesk.camera.set({ s, x: window.innerWidth / 2 - x * s, y: window.innerHeight / 2 - y * s }), { s, x: d.x + d.w / 2, y: d.y + d.h / 2 });
  await settled(page);
  await page.mouse.move(2, 790);
}

for (const theme of ['light', 'dusk', 'dark'] as ThemeId[]) {
  test(`${NAMES[theme]}: the chip at 75 and 175 %, none at 50 % or at icon size, and above "Open in its window"`, async ({ page, request }) => {
    mkdirSync(OUT, { recursive: true });
    const errors = await arrive(page, request, theme);
    const name = NAMES[theme];
    for (const [size, zooms] of [['medium', [0.75, 1.75, 0.5]], ['large', [0.75, 1.75, 0.5]], ['icon', [1, 1.75]]] as const) {
      for (const s of zooms) {
        await look(page, IDS[size], s);
        await page.screenshot({ path: `${OUT}/${name}-${size}-${s * 100}.png` });
      }
    }
    // An open Courier tile at 75 % (not live), its window open and moved off it.
    await page.locator(`[id="proxy-${IDS.open}"]`).evaluate((el) => (el as HTMLButtonElement).click());
    await settled(page);
    await look(page, IDS.open, 1);
    const live = page.getByTestId('open-tile-courier');
    await expect(live).toBeVisible();
    await live.getByRole('button', { name: 'Open in its window' }).click();
    const win = page.getByRole('dialog', { name: /Courier/ });
    await expect(win).toBeVisible();
    await look(page, IDS.open, 0.75);
    await expect(page.locator('.open-tile')).toHaveCount(0);
    const head = (await win.locator('.window-head').boundingBox())!;
    await page.mouse.move(head.x + head.width / 2, head.y + head.height / 2);
    await page.mouse.down();
    await page.mouse.move(1180, head.y + head.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.mouse.move(2, 790);
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/${name}-open-window-75.png` });
    expect(errors).toEqual([]);
  });
}
